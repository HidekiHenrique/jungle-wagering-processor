import type { IntegrationEvent } from '../../../../shared/domain/integration-event';

export interface OutboxRepository {
  /** Stores events for later publication, in the caller's transaction. */
  add(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OutboxRepository');
