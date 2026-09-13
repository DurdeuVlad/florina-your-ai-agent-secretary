/**
 * whisper.cpp backend — local speech-to-text (DEC-021).
 *
 * Defines the pluggable {@link WhisperBackend} interface and a concrete
 * {@link WhisperCppBackend} that spawns the `whisper.cpp` binary as a child
 * process. The child-process spawning is itself delegated to an injectable
 * {@link ProcessRunner} interface so the entire backend is testable without a
 * real `whisper.cpp` binary or model file.
 *
 * whisper.cpp is the primary local ASR engine for MVP push-to-talk
 * (DEEP_RESEARCH.md): zero-dependency, privacy-preserving, no cloud round-trip.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ================================================================== *
 * CLI options
 * ================================================================== */

/**
 * CLI flags forwarded to the `whisper.cpp` binary.
 *
 * These map directly onto `whisper-cli` arguments; see the whisper.cpp docs
 * for the full set. Only the subset relevant to the Florina pipeline is
 * modelled here.
 */
export interface WhisperCliOptions {
  /** Path to the `.ggml` model file (e.g. `ggml-base.en.bin`). */
  readonly model: string;
  /** Spoken language code (e.g. `en`, `fr`). `auto` enables auto-detect. */
  readonly language: string;
  /** Beam-search width (higher = more accurate, slower). */
  readonly beamSize: number;
  /** Whether to enable the speed-up heuristic (faster, slightly less accurate). */
  readonly speedUp: boolean;
  /** Emit JSON output (always `true` for the Florina pipeline). */
  readonly outputJson: boolean;
}

/** Default whisper.cpp CLI options. */
export const DEFAULT_WHISPER_CLI_OPTIONS: WhisperCliOptions = {
  model: '',
  language: 'auto',
  beamSize: 5,
  speedUp: false,
  outputJson: true,
};

/**
 * Build the `whisper-cli` argument vector from a {@link WhisperCliOptions}.
 *
 * The audio file path is appended separately by the backend at transcribe
 * time. Output is always JSON (`-oj`) so the result can be parsed.
 */
export function buildWhisperArgs(
  opts: WhisperCliOptions,
  audioPath: string,
): string[] {
  const args = ['-m', opts.model, '-l', opts.language, '-bs', String(opts.beamSize)];
  if (opts.speedUp) {
    args.push('-su');
  }
  if (opts.outputJson) {
    args.push('-oj');
  }
  args.push('-f', audioPath);
  return args;
}

/* ================================================================== *
 * whisper.cpp JSON output
 * ================================================================== */

/**
 * A single transcription segment from whisper.cpp.
 *
 * Mirrors the `whisper_segment` struct emitted in JSON output: timestamps,
 * text, and per-segment scoring fields used to derive confidence.
 */
export interface WhisperSegment {
  /** Segment id (0-indexed). */
  readonly id: number;
  /** Start time in seconds. */
  readonly start: number;
  /** End time in seconds. */
  readonly end: number;
  /** Transcribed text for this segment. */
  readonly text: string;
  /** Token ids produced by the model. */
  readonly tokens: readonly number[];
  /** Sampling temperature used for this segment. */
  readonly temperature: number;
  /** Average log-probability of the decoded tokens. */
  readonly avg_logprob: number;
  /** Compression ratio of the output (gzip-based repetition heuristic). */
  readonly compression_ratio: number;
  /** Probability that the segment is silence. */
  readonly no_speech_prob: number;
}

/**
 * The `result` object in whisper.cpp JSON output.
 */
export interface WhisperResult {
  /** Detected / forced language code. */
  readonly language: string;
  /** Full transcribed text (all segments concatenated). */
  readonly text: string;
  /** Per-segment transcription details. */
  readonly segments: readonly WhisperSegment[];
}

/**
 * Top-level whisper.cpp JSON output document.
 *
 * whisper.cpp emits `{"result": {...}}` when invoked with `-oj`.
 */
export interface WhisperJsonOutput {
  readonly result: WhisperResult;
}

/**
 * Parse raw whisper.cpp JSON output into a {@link WhisperResult}.
 *
 * Throws if the output is not valid JSON, lacks the `result` envelope, or is
 * missing required fields. This is the single point that validates the binary
 * contract so the adapter never receives malformed data.
 */
export function parseWhisperJsonOutput(raw: string): WhisperResult {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `whisper.cpp produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new Error('whisper.cpp output is not a JSON object');
  }
  const result = (doc as Record<string, unknown>).result;
  if (typeof result !== 'object' || result === null) {
    throw new Error('whisper.cpp output missing "result" envelope');
  }
  const r = result as Record<string, unknown>;
  if (typeof r.language !== 'string') {
    throw new Error('whisper.cpp result missing "language" string');
  }
  if (typeof r.text !== 'string') {
    throw new Error('whisper.cpp result missing "text" string');
  }
  if (!Array.isArray(r.segments)) {
    throw new Error('whisper.cpp result missing "segments" array');
  }
  const segments: WhisperSegment[] = r.segments.map((s, i) => {
    if (typeof s !== 'object' || s === null) {
      throw new Error(`whisper.cpp segment ${i} is not an object`);
    }
    const seg = s as Record<string, unknown>;
    return {
      id: typeof seg.id === 'number' ? seg.id : i,
      start: typeof seg.start === 'number' ? seg.start : 0,
      end: typeof seg.end === 'number' ? seg.end : 0,
      text: typeof seg.text === 'string' ? seg.text : '',
      tokens: Array.isArray(seg.tokens) ? (seg.tokens as number[]) : [],
      temperature: typeof seg.temperature === 'number' ? seg.temperature : 0,
      avg_logprob: typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0,
      compression_ratio:
        typeof seg.compression_ratio === 'number' ? seg.compression_ratio : 0,
      no_speech_prob:
        typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0,
    };
  });
  return { language: r.language, text: r.text, segments };
}

/* ================================================================== *
 * ProcessRunner — pluggable child-process spawn (for testing)
 * ================================================================== */

/**
 * Result of a {@link ProcessRunner.run} call.
 */
export interface ProcessResult {
  /** Combined / captured stdout. */
  readonly stdout: string;
  /** Combined / captured stderr. */
  readonly stderr: string;
  /** Process exit code (0 = success). */
  readonly exitCode: number;
}

/**
 * Pluggable interface for running a child process and capturing its output.
 *
 * The production implementation ({@link defaultProcessRunner}) spawns the
 * real `whisper-cli` binary via `node:child_process`. Tests inject a mock
 * that returns canned {@link ProcessResult}s without touching the OS.
 */
export interface ProcessRunner {
  /**
   * Run `command` with `args`, optionally writing `stdinData` to the child's
   * stdin. Resolves with the captured stdout/stderr and exit code. Rejects
   * only if the binary cannot be spawned (e.g. not found on PATH).
   */
  run(
    command: string,
    args: readonly string[],
    stdinData?: string,
    timeoutMs?: number,
  ): Promise<ProcessResult>;
}

/**
 * Error thrown when the spawned binary cannot be found / launched.
 */
export class ProcessNotFoundError extends Error {
  readonly binary: string;
  constructor(binary: string) {
    super(`Binary not found: ${binary}`);
    this.name = 'ProcessNotFoundError';
    this.binary = binary;
  }
}

/**
 * Error thrown when a child process exceeds its timeout.
 */
export class ProcessTimeoutError extends Error {
  readonly command: string;
  constructor(command: string, timeoutMs: number) {
    super(`Process "${command}" timed out after ${timeoutMs}ms`);
    this.name = 'ProcessTimeoutError';
    this.command = command;
  }
}

/**
 * Default {@link ProcessRunner} backed by `node:child_process.spawn`.
 *
 * Captures stdout/stderr as UTF-8 strings, writes optional stdin, and
 * rejects with {@link ProcessNotFoundError} when the binary is missing.
 */
export function defaultProcessRunner(): ProcessRunner {
  return {
    async run(
      command: string,
      args: readonly string[],
      stdinData?: string,
      timeoutMs?: number,
    ): Promise<ProcessResult> {
      return new Promise<ProcessResult>((resolve, reject) => {
        let child;
        try {
          child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          reject(new ProcessNotFoundError(command));
          return;
        }
        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            reject(new ProcessNotFoundError(command));
          } else {
            reject(err);
          }
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
        child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
        }
        child.on('close', (code) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (timedOut) {
            reject(new ProcessTimeoutError(command, timeoutMs ?? 0));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: code ?? 0,
          });
        });
        if (stdinData !== undefined && child.stdin !== null) {
          child.stdin.end(stdinData);
        }
      });
    },
  };
}

/* ================================================================== *
 * WhisperBackend interface + concrete WhisperCppBackend
 * ================================================================== */

/**
 * Pluggable whisper backend — the STT engine contract.
 *
 * {@link WhisperAdapter} depends on this interface rather than a concrete
 * implementation, so tests inject a mock backend and never require the real
 * `whisper.cpp` binary or a model file.
 */
export interface WhisperBackend {
  /** Load / verify the model at `modelPath` with the given options. */
  initialize(modelPath: string, options: WhisperCliOptions): Promise<void>;
  /** Transcribe raw audio data and return parsed whisper.cpp JSON output. */
  transcribe(audioData: Buffer): Promise<WhisperResult>;
  /** Whether the backend binary and model are available for use. */
  isAvailable(): Promise<boolean>;
  /** Release any held resources (temp files, handles). */
  close(): Promise<void>;
}

/** Default `whisper-cli` binary name (expected on PATH). */
export const DEFAULT_WHISPER_BINARY = 'whisper-cli';

/** Default transcription timeout in ms (30s). */
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * Concrete {@link WhisperBackend} that spawns the `whisper.cpp` binary.
 *
 * Audio is written to a temporary `.wav` file, `whisper-cli` is invoked with
 * the configured CLI flags, and its JSON stdout is parsed via
 * {@link parseWhisperJsonOutput}. The binary path, process runner, and temp
 * directory are all injectable for testability.
 */
export class WhisperCppBackend implements WhisperBackend {
  private readonly binary: string;
  private readonly runner: ProcessRunner;
  private readonly tempDir: string;
  private readonly timeoutMs: number;

  private options: WhisperCliOptions | null = null;
  private tempFiles: string[] = [];
  private initialized = false;

  constructor(opts?: {
    binary?: string;
    runner?: ProcessRunner;
    tempDir?: string;
    timeoutMs?: number;
  }) {
    this.binary = opts?.binary ?? DEFAULT_WHISPER_BINARY;
    this.runner = opts?.runner ?? defaultProcessRunner();
    this.tempDir = opts?.tempDir ?? tmpdir();
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
  }

  async initialize(modelPath: string, options: WhisperCliOptions): Promise<void> {
    // Verify the model file is readable.
    try {
      await access(modelPath, constants.R_OK);
    } catch {
      throw new Error(`whisper model not found or unreadable: ${modelPath}`);
    }
    this.options = { ...options, model: modelPath };
    this.initialized = true;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.initialized || this.options === null) {
      return false;
    }
    try {
      await access(this.options.model, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(audioData: Buffer): Promise<WhisperResult> {
    if (!this.initialized || this.options === null) {
      throw new Error('WhisperCppBackend not initialized');
    }
    const audioPath = join(
      this.tempDir,
      `florina-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );
    this.tempFiles.push(audioPath);
    await writeFile(audioPath, audioData);
    try {
      const args = buildWhisperArgs(this.options, audioPath);
      const result = await this.runner.run(
        this.binary,
        args,
        undefined,
        this.timeoutMs,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `whisper.cpp exited with code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
      return parseWhisperJsonOutput(result.stdout);
    } finally {
      await this.cleanupFile(audioPath);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.tempFiles.map((f) => this.cleanupFile(f)));
    this.tempFiles = [];
    this.initialized = false;
    this.options = null;
  }

  private async cleanupFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Best-effort cleanup; ignore errors for already-removed files.
    }
  }
}
