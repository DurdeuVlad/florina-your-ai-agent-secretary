/**
 * Voice module — dual-track realtime + offline pipeline (DEC-021).
 *
 * OpenAI Realtime API for sub-second fast-start; whisper.cpp for local offline.
 */
export * from './audio-types.js';
export * from './realtime-message.js';
export * from './realtime-bridge.js';
export * from './whisper-backend.js';
export * from './whisper-adapter.js';
export * from './voice-pipeline.js';
