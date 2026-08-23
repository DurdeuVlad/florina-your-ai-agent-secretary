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
