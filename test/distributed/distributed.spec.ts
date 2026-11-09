import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sendWagerRequest } from '../../src/modules/wagering/infrastructure/sqs/wager-request.producer';
import { createTestQueues, type TestQueues, waitFor } from '../integration/support/sqs-test-queues';
import { createTestApp, type TestApp, uuid } from '../integration/support/test-app';
import { countLogs, type Instance, startInstance } from './support/instances';

/**
 * Distributed scenarios with REAL independent processes (challenge §13: tests 4, 5 and 8).
 * Every instance runs HTTP, the SQS consumer, the outbox relay and the pending-reference worker,
 * all against the same PostgreSQL and SQS, exactly as N containers would in production.
 */
let db: TestApp;
let queues: TestQueues;
const running: Instance[] = [];
const savedEnv = { ...process.env };

const WORKERS_ON = {
  SQS_CONSUMER_ENABLED: 'true',
  OUTBOX_RELAY_ENABLED: 'true',
  PENDING_REFERENCE_WORKER_ENABLED: 'true',
  SQS_WAIT_TIME_SECONDS: '1',
  SHUTDOWN_TIMEOUT_MS: '5000',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
  OUTBOX_POLL_INTERVAL_MS: '200',
};

beforeAll(async () => {
  queues = await createTestQueues({ maxReceiveCount: 5, visibilityTimeout: 5 });
  queues.applyToEnv(); // inherited by the child processes
  db = await createTestApp(); // resets the schema; used only for SQL checks
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.stop('SIGKILL')));
});

afterAll(async () => {
  await db.close();
  await queues.destroy();
  process.env = savedEnv;
});

async function start(name: string, env: Record<string, string> = WORKERS_ON) {
  const instance = await startInstance(name, env);
  running.push(instance);
  return instance;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function openWallet(instance: Instance, amount: string) {
  const playerId = uuid();
  const res = await fetch(`${instance.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: brl(amount) }),
  });
  const body = (await res.json()) as { id: string };
  return { walletId: body.id, playerId };
}

function wager(owner: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = `d-${uuid()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: owner.playerId,
    walletId: owner.walletId,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: brl('5.00'),
    ...overrides,
  } as const;
}

function postWager(instance: Instance, data: ReturnType<typeof wager>) {
  const { idempotencyKey, ...body } = data;
  return fetch(`${instance.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  }).then((r) => r.status);
}

/** Global consistency check across ALL wallets. */
async function consistency() {
  const [row] = await db.sql<{
    divergent: string;
    unsettled: string;
    unpublished: string;
    duplicated_entries: string;
  }>(`
    SELECT
      (SELECT count(*) FROM wallets w
         WHERE w.balance <> COALESCE((SELECT SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END)
                                        FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)) AS divergent,
      (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING') AS unsettled,
      (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
      (SELECT count(*) FROM (SELECT transaction_id FROM wallet_ledger_entries GROUP BY transaction_id HAVING count(*) > 1) d)
        AS duplicated_entries`);
  return {
    divergent: Number(row?.divergent),
    unsettled: Number(row?.unsettled),
    unpublished: Number(row?.unpublished),
    duplicatedEntries: Number(row?.duplicated_entries),
  };
}

const countWhere = async (sql: string, params: unknown[] = []) =>
  Number((await db.sql<{ n: string }>(sql, params))[0]?.n);

/** BET transactions of these wallets only (the tests share the database). */
const betsOf = (owners: { walletId: string }[], extra = '') =>
  countWhere(
    `SELECT count(*) AS n FROM wager_transactions
      WHERE kind = 'BET' AND wallet_id IN (${owners.map(() => '?').join(', ')}) ${extra}`,
    owners.map((o) => o.walletId),
  );

const queueDrained = async () =>
  (await queues.depth(queues.urls.wager)) === 0 &&
  (await countWhere('SELECT count(*) AS n FROM outbox_messages WHERE published_at IS NULL')) === 0;

describe('3 independent instances (test 4)', () => {
  it(
    'HTTP and SQS duplicates spread over 3 processes: every wallet consistent, nothing applied twice',
    async () => {
      const instances = await Promise.all([start('a'), start('b'), start('c')]);
      const owners = await Promise.all(
        Array.from({ length: 5 }, () => openWallet(instances[0] as Instance, '100.00')),
      );

      // Per wallet: 30 bets of 5.00 (only 20 fit). Each bet is sent TWICE: by HTTP to a random
      // instance and by SQS (consumed by whichever instance polls first). All at once.
      const bets = owners.flatMap((owner) => Array.from({ length: 30 }, () => wager(owner)));
      const statuses = await Promise.all(
        bets.flatMap((bet, i) => [
          postWager(instances[i % 3] as Instance, bet),
          sendWagerRequest(queues.sqs, queues.urls.wager, bet).then(() => 0),
        ]),
      );
      expect(statuses.filter((s) => s !== 0).every((s) => [200, 201, 422].includes(s))).toBe(true);

      await waitFor(queueDrained, 60_000, 500);

      for (const owner of owners) {
        const [w] = await db.sql<{ balance: string }>(
          'SELECT balance::text AS balance FROM wallets WHERE id = ?',
          [owner.walletId],
        );
        expect(w?.balance).toBe('0.00');
        expect(
          await countWhere(
            `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
            [owner.walletId],
          ),
        ).toBe(20);
      }
      expect(await betsOf(owners)).toBe(150);
      expect(await betsOf(owners, `AND failure_code = 'INSUFFICIENT_FUNDS'`)).toBe(50);
      expect(await consistency()).toEqual({
        divergent: 0,
        unsettled: 0,
        unpublished: 0,
        duplicatedEntries: 0,
      });

      // The work really was shared: more than one process consumed messages.
      const consumers = instances.filter((i) => countLogs(i, 'Wager message processed') > 0);
      expect(consumers.length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 120_000 },
  );

  it(
    'two bets of 80.00 on 100.00 sent to two different processes: one PROCESSED, one REJECTED',
    async () => {
      const [a, b] = await Promise.all([start('a'), start('b')]);
      const owner = await openWallet(a, '100.00');
      const statuses = await Promise.all([
        postWager(a, wager(owner, { money: brl('80.00') })),
        postWager(b, wager(owner, { money: brl('80.00') })),
      ]);
      expect(statuses.sort()).toEqual([201, 422]);
      const [w] = await db.sql<{ balance: string }>(
        'SELECT balance::text AS balance FROM wallets WHERE id = ?',
        [owner.walletId],
      );
      expect(w?.balance).toBe('20.00');
    },
    { timeout: 60_000 },
  );
});

describe('crash with kill -9 during load (test 5)', () => {
  it(
    'a process killed mid-flight loses nothing and duplicates nothing',
    async () => {
      const instances = await Promise.all([start('a'), start('b'), start('c')]);
      const owners = await Promise.all(
        Array.from({ length: 6 }, () => openWallet(instances[0] as Instance, '100.00')),
      );
      const bets = owners.flatMap((owner) =>
        Array.from({ length: 15 }, () => wager(owner, { money: brl('1.00') })),
      );
      await Promise.all(bets.map((bet) => sendWagerRequest(queues.sqs, queues.urls.wager, bet)));

      // Kill one process abruptly while the queue is being consumed: no shutdown hooks, no acks,
      // possibly in the middle of a transaction or between COMMIT and DeleteMessage.
      await waitFor(async () => (await betsOf(owners)) >= 10);
      const victim = instances[1] as Instance;
      expect(await victim.stop('SIGKILL')).not.toBe(0);
      await start('replacement');

      await waitFor(queueDrained, 60_000, 500);

      expect(await betsOf(owners)).toBe(bets.length);
      for (const owner of owners) {
        const [w] = await db.sql<{ balance: string }>(
          'SELECT balance::text AS balance FROM wallets WHERE id = ?',
          [owner.walletId],
        );
        expect(w?.balance).toBe('85.00'); // 100 - 15 × 1.00, each bet applied exactly once
      }
      expect(await queues.depth(queues.urls.dlq)).toBe(0);
      expect(await consistency()).toEqual({
        divergent: 0,
        unsettled: 0,
        unpublished: 0,
        duplicatedEntries: 0,
      });
    },
    { timeout: 120_000 },
  );
});

describe('restart (test 8)', () => {
  it(
    'work left behind by a crashed process (outbox, pending references) completes after restart',
    async () => {
      // Phase 1: a process WITHOUT background workers commits operations, then crashes.
      const first = await start('first', {
        SQS_CONSUMER_ENABLED: 'false',
        OUTBOX_RELAY_ENABLED: 'false',
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
      });
      const owner = await openWallet(first, '100.00');
      const bet = wager(owner, { money: brl('30.00') });
      const rollback = wager(owner, {
        kind: 'ROLLBACK',
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(await postWager(first, rollback)).toBe(202);
      expect(await postWager(first, bet)).toBe(201);
      expect(
        await countWhere('SELECT count(*) AS n FROM outbox_messages WHERE published_at IS NULL'),
      ).toBeGreaterThan(0);
      await first.stop('SIGKILL');

      // Phase 2: a fresh process starts with workers on and finishes everything.
      const second = await start('second');
      await waitFor(
        async () =>
          (await countWhere(
            `SELECT count(*) AS n FROM wager_transactions WHERE external_transaction_id = ? AND status = 'PROCESSED'`,
            [rollback.externalTransactionId],
          )) === 1 && (await queueDrained()),
        30_000,
        300,
      );

      const [w] = await db.sql<{ balance: string }>(
        'SELECT balance::text AS balance FROM wallets WHERE id = ?',
        [owner.walletId],
      );
      expect(w?.balance).toBe('100.00');
      expect(await consistency()).toEqual({
        divergent: 0,
        unsettled: 0,
        unpublished: 0,
        duplicatedEntries: 0,
      });

      // Phase 3: graceful stop of the survivor (SIGTERM) runs the shutdown hooks.
      await second.stop('SIGTERM');
      expect(countLogs(second, 'Consumer stopped')).toBe(1);
      expect(countLogs(second, 'Outbox relay stopped')).toBe(1);
    },
    { timeout: 90_000 },
  );
});
