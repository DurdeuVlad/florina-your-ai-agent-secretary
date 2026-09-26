/**
 * Live event streaming endpoint (DEC-008, DEC-019) — inbound WebSocket
 * adapter.
 *
 * The daemon exposes a single WebSocket endpoint that all four surfaces (CLI,
 * desktop, voice, remote) connect to. Clients subscribe to the live
 * `SupervisorEvent` stream by sending a `subscribe` control message; every
 * event published to the internal event bus is then broadcast to all
 * connected subscribers as a typed envelope.
 *
 * This adapter depends on {@link EventSubscriberPort} — it never names a
 * concrete bus implementation; the outbound in-memory bus is wired in by the
 * composition root (issue #93).
 */
import type { WebSocket } from 'ws';

import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventSubscriberPort } from '../../../core/application/ports/outbound/event-stream.js';

/**
 * Wire envelope for messages broadcast to subscribers.
 */
export interface EventStreamMessage {
  /** Discriminant: always `event` for a streamed SupervisorEvent. */
  readonly type: 'event';
  /** The serialized SupervisorEvent payload (DEC-019). */
  readonly event: SupervisorEvent;
  /** Monotonic sequence number assigned by the bus for this session. */
  readonly seq: number;
}

/**
 * Control message a client sends to manage its subscription.
 */
export type EventStreamControlMessage =
  { readonly type: 'subscribe' } | { readonly type: 'unsubscribe' };

/**
 * Manages the set of WebSocket clients subscribed to the live event stream.
 *
 * The composition root creates one `EventStream` and registers every
 * incoming control-plane connection with it. A connection becomes a
 * subscriber only after it sends a `subscribe` control message.
 */
export class EventStream {
  private readonly bus: EventSubscriberPort;
  /** Map of subscribed WebSocket -> listener unsubscribe function. */
  private readonly subscribers = new Map<WebSocket, () => void>();

  constructor(bus: EventSubscriberPort) {
    this.bus = bus;
  }

  /**
   * Register a connection as a potential subscriber. The connection must send
   * a `subscribe` control message to start receiving events.
   *
   * @returns a cleanup function that removes the connection entirely.
   */
  register(socket: WebSocket): () => void {
    const onMessage = (data: unknown): void => {
      const msg = parseControlMessage(data);
      if (!msg) {
        return;
      }
      if (msg.type === 'subscribe') {
        this.subscribe(socket);
      } else if (msg.type === 'unsubscribe') {
        this.unsubscribe(socket);
      }
    };
    socket.on('message', onMessage);
    return () => {
      socket.off('message', onMessage);
      this.unsubscribe(socket);
    };
  }

  /** Begin broadcasting events to a single socket. No-op if already subscribed. */
  subscribe(socket: WebSocket): void {
    if (this.subscribers.has(socket)) {
      return;
    }
    const unsubscribe = this.bus.onEvent((event, seq) => {
      const message: EventStreamMessage = { type: 'event', event, seq };
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });
    this.subscribers.set(socket, unsubscribe);
  }

  /** Stop broadcasting events to a single socket. No-op if not subscribed. */
  unsubscribe(socket: WebSocket): void {
    const unsubscribe = this.subscribers.get(socket);
    if (unsubscribe) {
      unsubscribe();
      this.subscribers.delete(socket);
    }
  }

  /**
   * Broadcast a raw (non-event) message to every subscriber — ephemeral
   * pushes like `voice:state` that are intentionally not journaled
   * (issue #131). The payload is serialized verbatim.
   */
  broadcast(message: unknown): void {
    if (this.subscribers.size === 0) return;
    const text = JSON.stringify(message);
    for (const socket of this.subscribers.keys()) {
      if (socket.readyState === socket.OPEN) {
        socket.send(text);
      }
    }
  }

  /** Number of currently subscribed clients. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Remove all subscribers (used during shutdown). */
  close(): void {
    for (const [, unsubscribe] of this.subscribers) {
      unsubscribe();
    }
    this.subscribers.clear();
  }
}

/**
 * Parse and validate an incoming control message. Returns `null` for anything
 * that is not a valid {@link EventStreamControlMessage}.
 */
function parseControlMessage(data: unknown): EventStreamControlMessage | null {
  if (typeof data !== 'string' && !(data instanceof Buffer)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return null;
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'subscribe'
  ) {
    return { type: 'subscribe' };
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'unsubscribe'
  ) {
    return { type: 'unsubscribe' };
  }
  return null;
}
