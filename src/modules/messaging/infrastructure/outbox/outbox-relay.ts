import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../shared/application/clock.port';
import { APP_CONFIG, type AppConfig } from '../../../../shared/infrastructure/config/app-config';
import { OutboxMessage } from '../../domain/outbox-message';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../sqs/sqs-client.provider';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
}

export interface RelayResult {
  published: number;
  failed: number;
}

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes committed outbox messages to SQS. Runs in every instance.
 *
 * Each pass, inside one transaction:
 *   SELECT ... FOR UPDATE SKIP LOCKED   → claim a batch no other relay holds
 *   SendMessageBatch                     → publish (dedup id = event id)
 *   UPDATE published_at / attempts       → record the outcome
 *   COMMIT                               → release the claim
 *
 * SKIP LOCKED makes concurrent relays take disjoint batches instead of waiting or duplicating.
 * The transaction holds locks only on outbox rows (never on wallets), so publishing inside it
 * does not block financial operations.
 *
 * Crash between SendMessageBatch and COMMIT: the rows are unlocked still pending and get
 * published again. Delivery is at-least-once; consumers deduplicate by eventId (and the FIFO
 * queue drops duplicates of the same MessageDeduplicationId within 5 minutes).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queueUrls: QueueUrls,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.outboxRelayEnabled) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    await this.stop();
    this.logger.log({ msg: 'Outbox relay stopped' });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** One relay pass. Exposed for tests. */
  async relayOnce(batchSize = this.config.workers.outboxBatchSize): Promise<RelayResult> {
    const queueUrl = await this.queueUrls.get(this.config.sqs.eventsQueue);
    return this.em.fork().transactional(async (em) => {
      const rows = await em.execute<OutboxRow[]>(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           FROM outbox_messages
          WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY occurred_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [this.clock.now(), batchSize],
      );
      if (rows.length === 0) return { published: 0, failed: 0 };

      const failedIds = new Set<string>();
      for (let i = 0; i < rows.length; i += SQS_BATCH_LIMIT) {
        const chunk = rows.slice(i, i + SQS_BATCH_LIMIT);
        for (const id of await this.publish(queueUrl, chunk)) failedIds.add(id);
      }

      const now = this.clock.now();
      const publishedIds = rows.filter((r) => !failedIds.has(r.id)).map((r) => r.id);
      if (publishedIds.length > 0) {
        const placeholders = publishedIds.map(() => '?').join(', ');
        await em.execute(`UPDATE outbox_messages SET published_at = ? WHERE id IN (${placeholders})`, [
          now,
          ...publishedIds,
        ]);
      }
      for (const row of rows.filter((r) => failedIds.has(r.id))) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
        });
        message.scheduleRetry(now);
        await em.execute(`UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?`, [
          message.attempts,
          message.nextAttemptAt,
          message.id,
        ]);
      }
      if (failedIds.size > 0)
        this.logger.warn({ msg: 'Outbox publication failed; rescheduled', failed: failedIds.size });
      return { published: publishedIds.length, failed: failedIds.size };
    });
  }

  /** @returns ids that failed to publish. */
  private async publish(queueUrl: string, rows: OutboxRow[]): Promise<string[]> {
    const entries: SendMessageBatchRequestEntry[] = rows.map((row, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify(row.payload),
      // Per-wallet ordering for consumers; transaction events carry walletId in data.
      MessageGroupId: walletIdOf(row) ?? row.aggregate_id,
      MessageDeduplicationId: row.id,
      MessageAttributes: { eventType: { DataType: 'String', StringValue: row.event_type } },
    }));
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }),
      );
      return (result.Failed ?? []).map((f) => rows[Number(f.Id)]?.id).filter((id): id is string => !!id);
    } catch (error) {
      this.logger.warn({ msg: 'SendMessageBatch failed', error: String(error) });
      return rows.map((r) => r.id);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { published } = await this.relayOnce();
        // Drain quickly while there is backlog; otherwise wait for the next tick.
        if (published === 0) await Bun.sleep(this.config.workers.outboxPollIntervalMs);
      } catch (error) {
        this.logger.error({ msg: 'Relay pass failed', error: String(error) });
        await Bun.sleep(this.config.workers.outboxPollIntervalMs);
      }
    }
  }
}

function walletIdOf(row: OutboxRow): string | undefined {
  const data = row.payload.data as { walletId?: unknown } | undefined;
  return typeof data?.walletId === 'string' ? data.walletId : undefined;
}
