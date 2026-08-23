/**
 * WhisperAdapter — local STT fallback adapter (DEC-021).
 *
 * Wraps a pluggable {@link WhisperBackend} and exposes a small, testable
 * lifecycle (`initialize` / `transcribe` / `isAvailable` / `close`) plus a
 * typed {@link TranscriptResult}. The adapter converts raw {@link AudioChunk}
 * arrays (the same shape used by the Realtime pipeline) into a single buffer
 * for the backend and derives a confidence score from the segment log-probs.
 *
 * This is the local/offline privacy alternative to the OpenAI Realtime API
 * path (#21). Higher latency is accepted; no third-party API keys required.
 */
import type { AudioChunk } from './audio-types.js';
import type {
  WhisperBackend,
  WhisperCliOptions,
  WhisperSegment,
} from './whisper-backend.js';
import { DEFAULT_WHISPER_CLI_OPTIONS } from './whisper-backend.js';

/* ================================================================== *
 * Transcript result
 * ================================================================== */

/**
 * A completed transcription from the whisper backend.
 *
 * Unlike the streaming {@link TranscriptEvent} from the Realtime path, this
 * is a single final result — whisper.cpp transcribes a full buffer at once.
 */
export interface TranscriptResult {
  /** Full transcribed text (all segments concatenated). */
  readonly text: string;
  /** Overall confidence in [0, 1], derived from segment log-probs. */
  readonly confidence: number;
  /** Per-segment transcription details. */
  readonly segments: readonly TranscriptSegment[];
  /** Detected / forced language code. */
  readonly language: string;
}

/**
 * A single transcription segment surfaced to callers.
 *
 * A trimmed view of the raw {@link WhisperSegment} with a derived confidence.
 */
export interface TranscriptSegment {
  /** Segment id (0-indexed). */
  readonly id: number;
  /** Start time in seconds. */
  readonly start: number;
  /** End time in seconds. */
  readonly end: number;
  /** Transcribed text for this segment. */
  readonly text: string;
  /** Per-segment confidence in [0, 1]. */
  readonly confidence: number;
}

/* ================================================================== *
 * Adapter options
 * ================================================================== */

/**
 * Configuration for {@link WhisperAdapter.initialize}.
 */
export interface WhisperAdapterOptions {
  /** Spoken language code (e.g. `en`). `auto` enables auto-detect. */
  readonly language?: string;
  /** Beam-search width (higher = more accurate, slower). */
  readonly beamSize?: number;
  /** Enable the speed-up heuristic (faster, slightly less accurate). */
  readonly speedUp?: boolean;
}

/* ================================================================== *
 * Confidence derivation
 * ================================================================== */

/**
 * Compression-ratio threshold above which a whisper.cpp segment is considered
 * suspiciously repetitive.
 *
 * whisper.cpp reports a gzip-based compression ratio per segment; values near
 * 1.0 are normal, while ratios above this threshold typically indicate the
 * model is looping on repeated tokens — a known whisper.cpp failure mode.
 * Segments exceeding it have their confidence penalised by the inverse ratio
 * so callers can discount low-quality output.
 */
const COMPRESSION_RATIO_THRESHOLD = 3.0;

/**
 * Derive a per-segment confidence in [0, 1] from whisper.cpp scoring fields.
 *
 * `avg_logprob` is the mean log-probability of decoded tokens (typically in
 * [-1, 0]); exponentiating gives a probability-like score. We also discount
 * segments with a high `no_speech_prob` (silence) and penalise extreme
 * compression ratios (repetition). The result is clamped to [0, 1].
 */
export function segmentConfidence(seg: WhisperSegment): number {
  const logprob = seg.avg_logprob;
  const prob = Math.exp(logprob);
  const silenceDiscount = 1 - seg.no_speech_prob;
  // Penalise repetition: a compression ratio far from 1.0 indicates the
  // model is looping. Ratios above the threshold are suspicious in whisper.cpp.
  const compressionPenalty =
    seg.compression_ratio > COMPRESSION_RATIO_THRESHOLD
      ? 1 / seg.compression_ratio
      : 1;
  const score = prob * silenceDiscount * compressionPenalty;
  return Math.max(0, Math.min(1, score));
}

/**
 * Derive an overall transcript confidence as the mean of segment confidences,
 * weighted by segment duration. Returns 0 when there are no segments.
 */
export function overallConfidence(segments: readonly WhisperSegment[]): number {
  if (segments.length === 0) {
    return 0;
  }
  let totalWeight = 0;
  let weightedSum = 0;
  for (const seg of segments) {
    const duration = Math.max(0, seg.end - seg.start);
    const weight = duration > 0 ? duration : 1;
    weightedSum += segmentConfidence(seg) * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, weightedSum / totalWeight));
}

/* ================================================================== *
 * Audio chunk concatenation
 * ================================================================== */

/**
 * Concatenate an array of {@link AudioChunk}s into a single PCM buffer.
 *
 * Each chunk's `pcm` field is a Base64-encoded PCM16 string (the Realtime
 * wire format). This decodes and joins them into one `Buffer` suitable for
 * writing to a `.wav` file for whisper.cpp.
 */
export function concatAudioChunks(chunks: readonly AudioChunk[]): Buffer {
  const buffers = chunks.map((c) => Buffer.from(c.pcm, 'base64'));
  return Buffer.concat(buffers);
}

/* ================================================================== *
 * WhisperAdapter
 * ================================================================== */

/**
 * Local speech-to-text fallback adapter backed by a {@link WhisperBackend}.
 *
 * The backend is injected (typically {@link WhisperCppBackend} in production,
 * a mock in tests) so the adapter logic is fully decoupled from the
 * `whisper.cpp` binary. Use {@link WhisperAdapter.initialize} to load a
 * model, then {@link WhisperAdapter.transcribe} to convert audio chunks into
 * a {@link TranscriptResult}.
 */
export class WhisperAdapter {
  private readonly backend: WhisperBackend;
  private initialized = false;
  /**
   * Serializes concurrent `transcribe` calls. whisper.cpp processes one
   * audio buffer at a time, so a second call must wait for the first to
   * complete rather than invoking the backend re-entrantly.
   */
  private transcribeChain: Promise<void> = Promise.resolve();

  constructor(backend: WhisperBackend) {
    this.backend = backend;
  }

  /** Whether the adapter has been initialized and the backend is available. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Load the whisper model and configure the backend.
   *
   * @param modelPath Filesystem path to the `.ggml` model file.
   * @param options   Adapter options (language, beam size, speed-up).
   */
  async initialize(
    modelPath: string,
    options?: WhisperAdapterOptions,
  ): Promise<void> {
    const cliOptions: WhisperCliOptions = {
      ...DEFAULT_WHISPER_CLI_OPTIONS,
      model: modelPath,
      language: options?.language ?? DEFAULT_WHISPER_CLI_OPTIONS.language,
      beamSize: options?.beamSize ?? DEFAULT_WHISPER_CLI_OPTIONS.beamSize,
      speedUp: options?.speedUp ?? DEFAULT_WHISPER_CLI_OPTIONS.speedUp,
      outputJson: true,
    };
    await this.backend.initialize(modelPath, cliOptions);
    this.initialized = true;
  }

  /**
   * Transcribe an array of {@link AudioChunk}s into a {@link TranscriptResult}.
   *
   * The chunks are concatenated into a single PCM buffer and handed to the
   * backend. Throws if the adapter has not been initialized. Concurrent calls
   * are serialized so the backend is never invoked re-entrantly — a second
   * call waits for the first to complete. An empty audio buffer short-circuits
   * to an empty, zero-confidence result without invoking the backend.
   */
  async transcribe(chunks: readonly AudioChunk[]): Promise<TranscriptResult> {
    if (!this.initialized) {
      throw new Error('WhisperAdapter not initialized — call initialize() first');
    }
    const audioData = concatAudioChunks(chunks);
    if (audioData.length === 0) {
      // No audio to transcribe — return an empty, zero-confidence result
      // rather than invoking the backend with an empty buffer.
      return { text: '', confidence: 0, segments: [], language: '' };
    }
    // Serialize concurrent calls: the whisper.cpp backend processes one
    // audio buffer at a time, so a second call must wait for the first.
    const next = this.transcribeChain.then(
      () => this.runTranscribe(audioData),
      () => this.runTranscribe(audioData),
    );
    // Keep the chain alive regardless of rejection so a failure doesn't
    // block subsequent calls.
    this.transcribeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Perform the actual backend transcription + confidence derivation for a
   * single non-empty audio buffer. Called serially via {@link transcribe}.
   */
  private async runTranscribe(audioData: Buffer): Promise<TranscriptResult> {
    const result = await this.backend.transcribe(audioData);
    const segments: TranscriptSegment[] = result.segments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text,
      confidence: segmentConfidence(s),
    }));
    return {
      text: result.text,
      confidence: overallConfidence(result.segments),
      segments,
      language: result.language,
    };
  }

  /**
   * Whether the backend binary and model are currently available.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }
    return this.backend.isAvailable();
  }

  /**
   * Release backend resources (temp files, handles). The adapter must be
   * re-initialized before it can transcribe again.
   */
  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
  }
}
