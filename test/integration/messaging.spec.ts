import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  SendMessageCommand,
  type ServiceInputTypes,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRelay } from '../../src/modules/messaging/infrastructure/outbox/outbox-relay';
import {
  QUEUE_URLS,
  type QueueUrls,
  SQS_CLIENT,
} from '../../src/modules/messaging/infrastructure/sqs/sqs-client.provider';
import {
  sendWagerRequest,
  type WagerRequestData,
} from '../../src/modules/wagering/infrastructure/sqs/wager-request.producer';
import { WagerTransactionConsumer } from '../../src/modules/wagering/presentation/sqs/wager-transaction.consumer';
import { CLOCK, type Clock } from '../../src/shared/application/clock.port';
import { METRICS, type Metrics } from '../../src/shared/application/metrics.port';
import { APP_CONFIG, type AppConfig } from '../../src/shared/infrastructure/config/app-config';
import { createHttpTestApp, type HttpTestApp } from './support/http-app';
import { createTestQueues, type TestQueues, waitFor } from './support/sqs-test-queues';
import { uuid } from './support/test-app';

/**
 * Messaging end to end on real Postgres + real SQS (MiniStack). Each suite gets its own queues:
 * maxReceiveCount 2 so retry exhaustion is observable in seconds.
 */
let api: HttpTestApp;
let queues: TestQueues;
let consumer: WagerTransactionConsumer;
let relay: OutboxRelay;
const savedEnv = { ...process.env };

beforeAll(async () => {
  queues = await createTestQueues({ maxReceiveCount: 2, visibilityTimeout: 5 });
  queues.applyToEnv();
  process.env.DB_LOCK_TIMEOUT_MS = '300';
  process.env.SQS_RETRY_BASE_DELAY_SECONDS = '1';
  api = await createHttpTestApp();
  consumer = api.get(WagerTransactionConsumer);
  relay = api.get(OutboxRelay);
});

afterAll(async () => {
  await consumer.stop();
  await api.close();
  await queues.destroy();
  process.env = savedEnv;
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(amount = '100.00') {
  const playerId = uuid();
  const { body } = await api.request('POST', '/wallets', { body: { playerId, initialBalance: brl(amount) } });
  return { walletId: body.id as string, playerId };
}

function request(owner: { walletId: string; playerId: string }, overrides: Partial<WagerRequestData> = {}) {
  const externalTransactionId = `sqs-${uuid()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: owner.playerId,
    walletId: owner.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

const transactionByExternalId = async (externalId: string) =>
  (
    await api.sql<{ status: string; failure_code: string | null }>(
      'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ?',
      [externalId],
    )
  )[0];

const debits = async (walletId: string) =>
  Number(
    (
      await api.sql<{ n: string }>(
        `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [walletId],
      )
    )[0]?.n,
  );

const queueIsEmpty = async () => (await queues.depth(queues.urls.wager)) === 0;

describe('consumer (running)', () => {
  beforeAll(async () => {
    await consumer.start();
  });
  afterAll(async () => {
    await consumer.stop();
  });

  it('processes a message with the same use case as HTTP and acks it after commit', async () => {
    const owner = await openWallet();
    const data = request(owner);
    await sendWagerRequest(queues.sqs, queues.urls.wager, data);

    await waitFor(
      async () => (await transactionByExternalId(data.externalTransactionId))?.status === 'PROCESSED',
    );
    expect(await debits(owner.walletId)).toBe(1);
    expect(await waitFor(queueIsEmpty)).toBe(true);
  });

  it('a redelivered message (same messageId, new SQS message) is applied once: inbox', async () => {
    const owner = await openWallet();
    const data = request(owner);
    const messageId = uuid();
    // Different SQS deduplication ids defeat the FIFO dedup window: the inbox must catch it.
    await sendWagerRequest(queues.sqs, queues.urls.wager, data, messageId, {
      deduplicationId: `${messageId}-1`,
    });
    await sendWagerRequest(queues.sqs, queues.urls.wager, data, messageId, {
      deduplicationId: `${messageId}-2`,
    });

    await waitFor(
      async () => (await transactionByExternalId(data.externalTransactionId))?.status === 'PROCESSED',
    );
    await waitFor(queueIsEmpty);
    expect(await debits(owner.walletId)).toBe(1);
    const inbox = await api.sql('SELECT 1 FROM inbox_messages WHERE message_id = ?', [messageId]);
    expect(inbox).toHaveLength(1);
  });

  it('the same operation via HTTP and via SQS debits once (test 9)', async () => {
    const owner = await openWallet();
    const data = request(owner);
    const { idempotencyKey, ...body } = data;
    const http = await api.request('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    expect(http.status).toBe(201);

    await sendWagerRequest(queues.sqs, queues.urls.wager, data);
    await waitFor(queueIsEmpty);

    expect(await debits(owner.walletId)).toBe(1);
  });

  it('a business rejection is acked (final), not retried nor dead-lettered', async () => {
    const owner = await openWallet('10.00');
    const insufficient = request(owner, { money: brl('50.00') });
    const unknownWallet = request({ walletId: uuid(), playerId: uuid() });
    await sendWagerRequest(queues.sqs, queues.urls.wager, insufficient);
    await sendWagerRequest(queues.sqs, queues.urls.wager, unknownWallet);

    await waitFor(
      async () => (await transactionByExternalId(insufficient.externalTransactionId))?.status === 'REJECTED',
    );
    await waitFor(queueIsEmpty);
    expect((await transactionByExternalId(insufficient.externalTransactionId))?.failure_code).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect(await queues.receive(queues.urls.dlq, { waitSeconds: 1 })).toHaveLength(0);
  });

  it(
    'a malformed or impossible message goes to the DLQ immediately, with the reason',
    async () => {
      const owner = await openWallet();
      await queues.sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.urls.wager,
          MessageBody: '{not json',
          MessageGroupId: 'poison',
          MessageDeduplicationId: uuid(),
        }),
      );
      await sendWagerRequest(queues.sqs, queues.urls.wager, request(owner, { kind: 'OPENING' }));
      await sendWagerRequest(queues.sqs, queues.urls.wager, request(owner, { money: brl('1.005') }));

      // The DLQ is FIFO too: a received-but-not-deleted message blocks the next one of the same
      // group (here: the same wallet). So delete each one after reading it.
      const seen = new Map<string, Message>();
      const dead = await waitFor(async () => {
        for (const m of await queues.receive(queues.urls.dlq, { waitSeconds: 1 })) {
          seen.set(m.MessageId ?? '', m);
          await queues.sqs.send(
            new DeleteMessageCommand({ QueueUrl: queues.urls.dlq, ReceiptHandle: m.ReceiptHandle }),
          );
        }
        return seen.size >= 3 && [...seen.values()];
      });
      const reasons = dead.map((m) => m.MessageAttributes?.deadLetterReason?.StringValue ?? '').sort();
      expect(reasons[0]).toStartWith('INVALID_MESSAGE');
      expect(reasons.some((r) => r.includes('body is not JSON'))).toBe(true);
      expect(reasons.some((r) => r.startsWith('INVALID_MONEY'))).toBe(true);
      expect(await debits(owner.walletId)).toBe(0);
    },
    { timeout: 15_000 },
  );

  it('a transient failure is retried with backoff and then succeeds', async () => {
    const owner = await openWallet();
    const data = request(owner);

    // The wallet row stays locked for ~1.5 s: the first attempt hits lock_timeout (300 ms) and is
    // not acked; the message becomes visible again after 1 s and the next attempt succeeds.
    const lockedUntil = Date.now() + 1_500;
    await api.withRowLock('wallets', owner.walletId, async () => {
      await sendWagerRequest(queues.sqs, queues.urls.wager, data);
      await Bun.sleep(1_500);
    });

    await waitFor(
      async () => (await transactionByExternalId(data.externalTransactionId))?.status === 'PROCESSED',
    );
    expect(Date.now()).toBeGreaterThan(lockedUntil);
    expect(await debits(owner.walletId)).toBe(1);
  });

  it(
    'after maxReceiveCount transient failures SQS moves the message to the DLQ (redrive)',
    async () => {
      const owner = await openWallet();
      const data = request(owner);

      await api.withRowLock('wallets', owner.walletId, async () => {
        await sendWagerRequest(queues.sqs, queues.urls.wager, data);
        // Long enough for 2 failed receives (backoff 1 s, then 2 s) and the redrive.
        await waitFor(async () => {
          const dead = await queues.receive(queues.urls.dlq, { waitSeconds: 1 });
          return dead.some((m) => m.Body?.includes(data.externalTransactionId));
        }, 12_000);
      });

      expect(await transactionByExternalId(data.externalTransactionId)).toBeUndefined();
      expect(await debits(owner.walletId)).toBe(0);
    },
    { timeout: 20_000 },
  );
});

describe('crash between commit and ack (test 5)', () => {
  it(
    'the redelivery is recognized by the inbox and acked without a second effect',
    async () => {
      await consumer.stop();
      const owner = await openWallet();
      const data = request(owner);
      const messageId = await sendWagerRequest(queues.sqs, queues.urls.wager, data);

      // Worker 1 receives and processes (DB commit) but "dies" before DeleteMessage.
      const [message] = await waitFor(async () => {
        const received = await queues.receive(queues.urls.wager, { waitSeconds: 1 });
        return received.length > 0 && received;
      });
      if (!message) throw new Error('no message');
      expect(await consumer.handle(message)).toEqual({ action: 'ack' }); // decision never applied
      expect(await debits(owner.walletId)).toBe(1);
      // Visibility timeout elapses (forced to 0 here instead of waiting).
      await queues.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.urls.wager,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );

      // Worker 2 picks the redelivery.
      await consumer.start();
      await waitFor(queueIsEmpty);
      await consumer.stop();

      expect(await debits(owner.walletId)).toBe(1);
      expect(await api.sql('SELECT 1 FROM inbox_messages WHERE message_id = ?', [messageId])).toHaveLength(1);
    },
    { timeout: 15_000 },
  );
});

describe('outbox relay', () => {
  const relayWith = (sqs: Pick<SQSClient, 'send'>) =>
    new OutboxRelay(
      api.get(EntityManager),
      sqs as SQSClient,
      api.get<QueueUrls>(QUEUE_URLS),
      api.get<Clock>(CLOCK),
      api.get<AppConfig>(APP_CONFIG),
      api.get<Metrics>(METRICS),
    );

  async function drain(r: OutboxRelay) {
    while ((await r.relayOnce()).published > 0) {
      /* keep going */
    }
  }

  it('publishes committed events to SQS after the fact (process died before publishing)', async () => {
    // The HTTP request commits wallet + ledger + outbox; no relay runs during it.
    const owner = await openWallet('50.00');
    await drain(relay); // events of earlier tests and of the opening
    const { idempotencyKey, ...body } = request(owner);
    const { body: result } = await api.request('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    const pending = await api.sql('SELECT id FROM outbox_messages WHERE published_at IS NULL');
    expect(pending.length).toBe(2);

    // "Another instance" starts and relays.
    await drain(relayWith(api.get<SQSClient>(SQS_CLIENT)));

    expect(await api.sql('SELECT id FROM outbox_messages WHERE published_at IS NULL')).toHaveLength(0);
    const published = await waitFor(async () => {
      const messages = await queues.receive(queues.urls.events, { waitSeconds: 1 });
      const mine = messages.filter((m) => m.Body?.includes(result.transactionId));
      return mine.length >= 2 && mine;
    });
    const types = published.map((m) => m.MessageAttributes?.eventType?.StringValue).sort();
    expect(types).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(published.every((m) => m.Attributes?.MessageGroupId === owner.walletId)).toBe(true);
    const envelope = JSON.parse(published[0]?.Body ?? '{}');
    expect(envelope).toMatchObject({
      version: 1,
      correlationId: expect.any(String),
      occurredAt: expect.any(String),
    });
  });

  it('two relays on the same outbox publish every event exactly once (SKIP LOCKED)', async () => {
    await drain(relay);
    const total = 60;
    for (let i = 0; i < total; i++) {
      const id = uuid();
      await api.sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
         VALUES (?, ?, 'TestEvent', ?, now(), 0)`,
        [id, `agg-${i % 5}`, JSON.stringify({ eventId: id, data: {} })],
      );
    }
    const sent: string[] = [];
    const real = api.get<SQSClient>(SQS_CLIENT);
    const spy = (label: string) => ({
      send: async (command: { input: ServiceInputTypes }) => {
        const entries = (command.input as { Entries?: { MessageDeduplicationId?: string }[] }).Entries ?? [];
        sent.push(...entries.map((e) => `${label}:${e.MessageDeduplicationId}`));
        return real.send(command as never);
      },
    });
    const [a, b] = [relayWith(spy('A')), relayWith(spy('B'))];

    await Promise.all([1, 2, 3].flatMap(() => [a.relayOnce(5), b.relayOnce(5)]));
    await Promise.all([drain(a), drain(b)]);

    const ids = sent.map((s) => s.split(':')[1]);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(sent.some((s) => s.startsWith('A:'))).toBe(true);
    expect(sent.some((s) => s.startsWith('B:'))).toBe(true);
    expect(await api.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).toHaveLength(0);
  });

  it('a failed publication is rescheduled with backoff and published later', async () => {
    await drain(relay);
    const id = uuid();
    await api.sql(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       VALUES (?, 'agg', 'TestEvent', '{"data":{}}', now(), 0)`,
      [id],
    );

    const broken = relayWith({ send: async () => Promise.reject(new Error('SQS unavailable')) });
    expect(await broken.relayOnce()).toEqual({ published: 0, failed: 1 });
    const [row] = await api.sql<{ attempts: number; next_attempt_at: Date; published_at: Date | null }>(
      'SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = ?',
      [id],
    );
    expect(row?.attempts).toBe(1);
    expect(row?.published_at).toBeNull();
    expect(new Date(row?.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());

    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 0 }); // not due yet
    await Bun.sleep(1_100);
    expect(await relay.relayOnce()).toEqual({ published: 1, failed: 0 });
  });
});
