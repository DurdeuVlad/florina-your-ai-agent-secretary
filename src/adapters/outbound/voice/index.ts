/**
 * Voice adapters (DEC-021, issue #92) — the Realtime bridge wire codec and
 * bridge, plus the whisper.cpp offline backend and adapter. All depend on
 * the provider-neutral core voice port for audio/event types.
 */
export * from './realtime-message.js';
export * from './realtime-bridge.js';
export * from './whisper-backend.js';
export * from './whisper-adapter.js';
