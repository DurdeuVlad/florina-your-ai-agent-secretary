import type { SupervisorEvent } from '../../../domain/events.js';

export type SupervisorEventListener = (event: SupervisorEvent, sequence: number) => void;

export interface EventPublisherPort {
  publish(event: SupervisorEvent): number;
}

export interface EventSubscriberPort {
  onEvent(listener: SupervisorEventListener): () => void;
  readonly currentSeq: number;
}

export type EventBusPort = EventPublisherPort & EventSubscriberPort;
