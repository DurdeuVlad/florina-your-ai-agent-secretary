/**
 * In-memory event bus — canonical outbound implementation of the core
 * {@link EventBusPort} (DEC-008, DEC-019, issue #92).
 *
 * A thin wrapper around `EventEmitter` so the application owns a single
 * fan-out point; adapters never touch WebSocket connections directly —
 * the daemon's inbound {@link EventStream} subscribes through the
 * {@link EventSubscriberPort} view.
 */
import { EventEmitter } from 'node:events';

import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventBusPort } from '../../../core/application/ports/outbound/event-stream.js';

/**
 * Event names emitted by the internal {@link EventBus}.
 */
export const EventBusEvents = {
  /** A new SupervisorEvent was published by an adapter. */
  Event: 'event',
} as const;

/**
 * Internal event bus that adapters publish to and the stream broadcasts from.
 */
export class EventBus extends EventEmitter implements EventBusPort {
  private sequence = 0;

  constructor() {
    super();
    // Allow a large number of concurrent subscribers without Node warning.
    this.setMaxListeners(0);
  }

  /**
   * Publish a validated SupervisorEvent to all listeners. The bus assigns a
   * monotonic sequence number so subscribers can detect gaps after reconnect.
   */
  publish(event: SupervisorEvent): number {
    const seq = ++this.sequence;
    this.emit(EventBusEvents.Event, event, seq);
    return seq;
  }

  /** Subscribe to the event stream. Returns an unsubscribe function. */
  onEvent(listener: (event: SupervisorEvent, seq: number) => void): () => void {
    this.on(EventBusEvents.Event, listener);
    return () => this.off(EventBusEvents.Event, listener);
  }

  /** Current sequence counter (for diagnostics / health). */
  get currentSeq(): number {
    return this.sequence;
  }
}
