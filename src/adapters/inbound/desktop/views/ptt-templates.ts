/**
 * Template functions for the Push-to-Talk voice HUD (DEC-002, DEC-028,
 * issue #28).
 *
 * Each template returns a {@link RenderTree} — a plain, serializable object
 * describing a renderable element (`{ tag, props, children }`). No DOM, no
 * React, no framework. Any renderer (desktop overlay window, webview, TUI,
 * test harness) can walk the tree and project it onto its own surface.
 *
 * The HUD is a compact, always-on-top overlay (DEC-028). Style hints are
 * embedded in `props` as semantic tokens so each surface maps them to its
 * own palette/layout. Color coding follows the issue #28 spec:
 * - listening  → green
 * - processing → yellow
 * - responding → blue
 * - offline    → gray
 *
 * Event handlers are expressed as **string command identifiers** (never
 * closures) so the whole tree is JSON-serializable and can cross the IPC
 * boundary.
 */
import type { VoicePipelineMode } from '../../../../core/application/use-cases/voice/voice-pipeline.js';
import type { RenderTree } from './view-types.js';
import type { PttHudState } from './ptt-hud.js';

/* ------------------------------------------------------------------ *
 * Primitive element helpers
 * ------------------------------------------------------------------ */

/** Create a {@link RenderTree} node. */
function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** A text node (represented as a plain string child). */
function text(value: string): string {
  return value;
}

/* ------------------------------------------------------------------ *
 * Color coding
 * ------------------------------------------------------------------ */

/**
 * Semantic color token for each HUD activity state (issue #28):
 * listening=green, processing=yellow, responding=blue, offline=gray.
 */
const STATE_COLORS: Readonly<Record<string, string>> = {
  listening: 'green',
  processing: 'yellow',
  responding: 'blue',
  offline: 'gray',
};

/** Semantic color token for each voice mode. */
const MODE_COLORS: Readonly<Record<VoicePipelineMode, string>> = {
  realtime: 'blue',
  whisper: 'amber',
  offline: 'gray',
};

/** Human-readable label for each voice mode. */
const MODE_LABELS: Readonly<Record<VoicePipelineMode, string>> = {
  realtime: 'Realtime',
  whisper: 'Whisper',
  offline: 'Offline',
};

/** Icon identifier for each voice mode. */
const MODE_ICONS: Readonly<Record<VoicePipelineMode, string>> = {
  realtime: 'bolt',
  whisper: 'waveform',
  offline: 'power-off',
};

/* ------------------------------------------------------------------ *
 * HUD templates
 * ------------------------------------------------------------------ */

/**
 * Render the compact, always-on-top PTT HUD overlay.
 *
 * Composes the PTT button, voice mode indicator, transcript preview,
 * response preview, and hotkey hint into a single overlay container. The
 * container carries the active-state color so a renderer can theme the
 * whole overlay (e.g. a glowing border) from a single token.
 *
 * @param state - The current HUD state.
 * @returns A serializable RenderTree describing the overlay HUD.
 */
export function renderPttHud(state: PttHudState): RenderTree {
  const activeState = activeStateLabel(state);
  const color = STATE_COLORS[activeState] ?? 'gray';
  const children: (RenderTree | string)[] = [
    renderPttButton(state),
    renderVoiceModeIndicator(state.voiceMode),
  ];
  if (state.currentTranscript.length > 0) {
    children.push(renderTranscriptPreview(state.currentTranscript));
  }
  if (state.responsePreview.length > 0) {
    children.push(renderResponsePreview(state.responsePreview));
  }
  if (state.hotkeyHint.length > 0) {
    children.push(renderHotkeyHint(state.hotkeyHint));
  }
  return el(
    'PttHud',
    {
      layout: 'column',
      gap: 'sm',
      padding: 'sm',
      alwaysOnTop: true,
      overlay: true,
      activeState,
      color,
    },
    children,
  );
}

/**
 * Render the PTT button with active/inactive visual states.
 *
 * The button reflects the current activity state (listening / processing /
 * responding / idle) via a color token and an icon. It carries a string
 * command identifier (`ptt:toggle`) so the renderer can dispatch the press
 * without closures, keeping the tree JSON-serializable.
 *
 * @param state - The current HUD state.
 * @returns A serializable RenderTree for the PTT button.
 */
export function renderPttButton(state: PttHudState): RenderTree {
  const active = state.isListening || state.isProcessing || state.isResponding;
  const activeState = activeStateLabel(state);
  const color = STATE_COLORS[activeState] ?? 'gray';
  const icon = active ? pttIconFor(activeState) : 'mic';
  const label = active ? activeStateLabel(state) : 'Push to talk';
  return el(
    'PttButton',
    {
      command: 'ptt:toggle',
      active,
      activeState,
      color,
      icon,
      size: 'lg',
      variant: 'round',
    },
    [text(label)],
  );
}

/**
 * Render a live transcript preview.
 *
 * @param text - The (possibly partial) transcript text.
 * @returns A serializable RenderTree for the transcript line.
 */
export function renderTranscriptPreview(text: string): RenderTree {
  return el(
    'TranscriptPreview',
    { color: 'muted', italic: true, truncate: true, selectable: true },
    [text],
  );
}

/**
 * Render the voice mode indicator (realtime / whisper / offline).
 *
 * @param mode - The currently-active voice pipeline mode.
 * @returns A serializable RenderTree for the mode badge.
 */
export function renderVoiceModeIndicator(mode: VoicePipelineMode): RenderTree {
  return el(
    'VoiceModeIndicator',
    { mode, color: MODE_COLORS[mode], icon: MODE_ICONS[mode], size: 'sm' },
    [text(MODE_LABELS[mode])],
  );
}

/**
 * Render a keyboard shortcut hint.
 *
 * @param hint - The hotkey hint text (e.g. "Hold ⌘␣ to talk").
 * @returns A serializable RenderTree for the hint line.
 */
export function renderHotkeyHint(hint: string): RenderTree {
  return el(
    'HotkeyHint',
    { color: 'muted', size: 'xs', align: 'center' },
    [text(hint)],
  );
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Render a preview of the AI's current response text. Exported for testing
 * but not part of the public issue #28 template list; the response preview
 * is rendered inline by {@link renderPttHud}.
 */
export function renderResponsePreview(text: string): RenderTree {
  return el(
    'ResponsePreview',
    { color: 'blue', truncate: true, selectable: true },
    [text],
  );
}

/** Determine the active-state label for a HUD state (for color coding). */
function activeStateLabel(state: PttHudState): string {
  if (state.voiceMode === 'offline') return 'offline';
  if (state.isListening) return 'listening';
  if (state.isProcessing) return 'processing';
  if (state.isResponding) return 'responding';
  return 'offline';
}

/** Choose a PTT icon glyph for an active state. */
function pttIconFor(activeState: string): string {
  switch (activeState) {
    case 'listening':
      return 'mic-on';
    case 'processing':
      return 'spinner';
    case 'responding':
      return 'speaker';
    default:
      return 'mic';
  }
}
