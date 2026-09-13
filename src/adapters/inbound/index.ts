/**
 * Inbound adapters — surfaces that drive the application through core ports
 * and use cases (DEC-037, issue #93).
 *
 * Each subtree is an isolated adapter family; concrete combinations with
 * outbound adapters happen in bootstrap, never inside a family.
 */
export * from './desktop/index.js';
export * from './websocket/index.js';
