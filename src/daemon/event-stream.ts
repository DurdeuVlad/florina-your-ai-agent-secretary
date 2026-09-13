/**
 * Compatibility barrel (issue #93). The canonical implementations live in
 * the adapter families:
 *
 * - {@link EventStream} — the inbound WebSocket event surface — in
 *   `src/adapters/inbound/websocket/event-stream.ts`.
 * - {@link EventBus} / {@link EventBusEvents} — the outbound in-memory event
 *   bus — in `src/adapters/outbound/events/in-memory-event-bus.ts`.
 *
 * This module re-exports both so existing `src/daemon/event-stream.js`
 * imports keep working.
 */
export { EventBus, EventBusEvents } from '../adapters/outbound/events/in-memory-event-bus.js';
export { EventStream } from '../adapters/inbound/websocket/event-stream.js';
export type {
  EventStreamMessage,
  EventStreamControlMessage,
} from '../adapters/inbound/websocket/event-stream.js';
