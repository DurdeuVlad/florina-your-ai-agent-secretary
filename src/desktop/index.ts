/**
 * Desktop module — lightweight desktop client (Electron/Tauri) over the
 * local daemon (DEC-028, issue #24). Strictly a client; 100% feature parity
 * with the CLI. No business logic lives here — all state originates from the
 * daemon and is mirrored into the renderer via IPC.
 *
 * This barrel re-exports the skeleton primitives so consumers can import from
 * a single entry point. No real Electron/Tauri runtime is required; the
 * module ships in-memory mocks for testing.
 */
export {
  DesktopApp,
  DesktopConnectionError,
} from './desktop-app.js';
export type { DesktopAppOptions } from './desktop-app.js';

export {
  IpcBridge,
  IpcError,
  IPC_CHANNELS,
  MockIpcTransport,
} from './ipc-bridge.js';
export type {
  IpcChannel,
  IpcMessageHandler,
  IpcTransport,
} from './ipc-bridge.js';

export {
  RendererState,
  DEFAULT_RENDERER_STATE,
  DEFAULT_VOICE_STATE,
} from './renderer-state.js';
export type {
  DaemonStatus,
  RendererStateData,
  RendererView,
  StateChangeCallback,
  VoiceState,
} from './renderer-state.js';

export {
  MockWindowBackend,
  DEFAULT_WINDOW_BOUNDS,
  DEFAULT_WINDOW_OPTIONS,
} from './window-backend.js';
export type {
  WindowBackend,
  WindowBounds,
  WindowEvent,
  WindowEventHandler,
  WindowOptions,
} from './window-backend.js';

export { InboxViewModel, KIND_METADATA, PRIORITY_METADATA } from './views/inbox-view.js';
export {
  renderInboxItem,
  renderInboxGroup,
  renderInboxList,
  renderEmptyState,
  renderFilterBar,
} from './views/inbox-templates.js';
export type {
  AttentionItemView,
  DisplayMetadata,
  InboxViewData,
  PriorityGroup,
  RenderTree,
  ViewFilter,
} from './views/view-types.js';

export { ApprovalCardViewModel, CAPABILITY_LABELS, RISK_COLORS, RISK_LABELS } from './views/approval-card.js';
export {
  renderApprovalCard,
  renderRiskBadge,
  renderCapabilityDetails,
  renderApprovalActions,
  renderRiskFactors,
} from './views/approval-templates.js';
export type {
  ApprovalAction,
  ApprovalCardData,
  ApprovalContext,
  RiskAssessmentDisplay,
  RiskColor,
} from './views/approval-types.js';

export { DigestViewModel, formatDuration } from './views/digest-view.js';
export { DiffViewModel, LARGE_CHANGE_THRESHOLD } from './views/diff-view.js';
export {
  renderDigest,
  renderDigestSummary,
  renderTestResults,
  renderApprovalStats,
  renderRiskHighlights,
  renderDiffView,
  renderFileList,
  renderDiffStats,
} from './views/digest-templates.js';
export type {
  ApprovalStatsView,
  DiffStatsView,
  DiffViewData,
  DigestColor,
  DigestViewData,
  FileChangeView,
  FileGroupView,
  RiskHighlightView,
  TestResultsView,
} from './views/digest-types.js';

export { PttHudViewModel, DEFAULT_PTT_HUD_STATE } from './views/ptt-hud.js';
export type { PttHudState, PttHudStateCallback } from './views/ptt-hud.js';
export {
  renderPttHud,
  renderPttButton,
  renderTranscriptPreview,
  renderVoiceModeIndicator,
  renderHotkeyHint,
  renderResponsePreview,
} from './views/ptt-templates.js';

export {
  HotkeyManager,
  MockKeyboardBackend,
  DEFAULT_HOTKEYS,
  parseAccelerator,
} from './hotkeys.js';
export type {
  HotkeyAction,
  KeyEventLike,
  KeyboardBackend,
  ParsedAccelerator,
} from './hotkeys.js';

export { SystemTrayManager, MockTrayBackend } from './system-tray.js';
export type {
  TrayAction,
  TrayActionCallback,
  TrayBackend,
  TrayMenuItem,
} from './system-tray.js';

export { KeyboardNavigator } from './keyboard-nav.js';
export type { NavAction, NavActionCallback } from './keyboard-nav.js';
