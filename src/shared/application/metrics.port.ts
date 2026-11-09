/**
 * Business and operational metrics the use cases report. Technology-neutral: the application
 * says what happened; the infrastructure decides how it is exported (Prometheus here).
 */
export type Channel = 'http' | 'sqs' | 'pending-reference' | 'internal';

export interface Metrics {
  /** A transaction reached an outcome (first time, not replays). */
  transactionSettled(status: string, kind: string, channel: Channel): void;
  /** A duplicate was detected and answered from stored state. */
  duplicateDetected(source: 'idempotency-key' | 'inbox'): void;
  /** Wall time of one processing attempt, from command to commit. */
  processingDuration(channel: Channel, seconds: number): void;
  /** Something will be tried again later. */
  retryScheduled(source: 'sqs-message' | 'pending-reference' | 'outbox-publish'): void;
  /** A message was moved to a DLQ by the application (redrive moves are counted by the DLQ gauge). */
  deadLettered(queue: string): void;
  /** A database concurrency conflict surfaced as a transient error. */
  lockConflict(kind: 'lock_timeout' | 'deadlock' | 'serialization' | 'version_conflict'): void;
  reconciliationChecked(consistent: boolean): void;
}

export const METRICS = Symbol('Metrics');
