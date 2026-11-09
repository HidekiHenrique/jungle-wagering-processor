import { BackoffPolicy } from '../../../shared/domain/backoff-policy';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

/** Defaults for publication retries: 1s, 2s, 4s ... capped at 1 min. Attempts are not capped. */
export const DEFAULT_OUTBOX_RETRY = BackoffPolicy.of({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: Number.MAX_SAFE_INTEGER,
});

/**
 * An integration event waiting to be published.
 *
 * Written in the same SQL transaction as the financial change that produced it, so a committed
 * change always has its event (and a rolled back one never does). A relay publishes it later.
 * Its id is the event id: consumers deduplicate by it, which makes republishing safe.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pending and not waiting for a backoff delay. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending())
      throw new InvariantViolationError(`outbox message ${this.id} is already published`);
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Records a failed publication and schedules the next try. */
  scheduleRetry(now: Date, policy: BackoffPolicy = DEFAULT_OUTBOX_RETRY): void {
    if (!this.isPending())
      throw new InvariantViolationError(`outbox message ${this.id} is already published`);
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts);
  }
}
