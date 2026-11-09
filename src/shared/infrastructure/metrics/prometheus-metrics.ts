import { Injectable } from '@nestjs/common';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { Channel, Metrics } from '../../application/metrics.port';

/**
 * Prometheus implementation of the Metrics port, exposed at GET /metrics.
 * Gauges that need I/O (outbox lag, DLQ depth) are computed at scrape time by collectors
 * registered by their owning modules (see registerGauge).
 */
@Injectable()
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transactions that reached an outcome, by status, kind and entry channel',
    labelNames: ['status', 'kind', 'channel'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicates detected and answered from stored state',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Processing time of one attempt, from command to commit',
    labelNames: ['channel'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'retries_total',
    help: 'Work scheduled to be tried again',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Messages moved to a DLQ by the application',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'db_lock_conflicts_total',
    help: 'Database concurrency conflicts surfaced as transient errors',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wallet_reconciliations_total',
    help: 'Reconciliation checks by result (inconsistent = balance diverges from ledger)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionSettled(status: string, kind: string, channel: Channel): void {
    this.transactions.inc({ status, kind, channel });
  }
  duplicateDetected(source: 'idempotency-key' | 'inbox'): void {
    this.duplicates.inc({ source });
  }
  processingDuration(channel: Channel, seconds: number): void {
    this.duration.observe({ channel }, seconds);
  }
  retryScheduled(source: 'sqs-message' | 'pending-reference' | 'outbox-publish'): void {
    this.retries.inc({ source });
  }
  deadLettered(queue: string): void {
    this.deadLetters.inc({ queue });
  }
  lockConflict(kind: 'lock_timeout' | 'deadlock' | 'serialization' | 'version_conflict'): void {
    this.lockConflicts.inc({ kind });
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'inconsistent' });
  }

  /** Registers a gauge whose value is computed when Prometheus scrapes. */
  registerGauge(name: string, help: string, read: () => Promise<number>): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await read());
        } catch {
          this.set(Number.NaN); // unknown, not zero: a failed read must not look healthy
        }
      },
    });
  }
}
