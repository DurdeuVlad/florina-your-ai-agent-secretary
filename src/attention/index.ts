/**
 * Attention module — the deterministic attention engine (DEC-014).
 *
 * Classifies agent events into always-surface / batch / elevate buckets and
 * computes the Attention Compression Ratio (DEC-015).
 */
export * from './engine.js';
export * from './failure-tracker.js';
export * from './liveness-monitor.js';
export * from './attention-item.js';
export * from './attention-inbox.js';
export * from './attention-aggregator.js';
