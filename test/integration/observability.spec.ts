import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHttpTestApp, type HttpTestApp } from './support/http-app';
import { uuid } from './support/test-app';

let api: HttpTestApp;

const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.DB_LOCK_TIMEOUT_MS = '300';
  api = await createHttpTestApp();
});
afterAll(async () => {
  await api.close();
  process.env = savedEnv;
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function scrape(): Promise<string> {
  const res = await fetch(`${api.baseUrl}/metrics`);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

/** Value of one Prometheus sample, e.g. metric('wager_transactions_total', { status: 'PROCESSED' }). */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const line = text
    .split('\n')
    .find(
      (l) =>
        (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) &&
        Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)),
    );
  return line ? Number(line.split(' ').at(-1)) : 0;
}

describe('health', () => {
  it('liveness and readiness are open and report dependencies', async () => {
    expect(await api.request('GET', '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(await api.request('GET', '/health/ready')).toMatchObject({
      status: 200,
      body: { status: 'ok', checks: { database: 'up', sqs: 'up' } },
    });
  });
});

describe('metrics', () => {
  it('counts outcomes, duplicates, latency, outbox and reconciliation', async () => {
    const before = await scrape();
    const playerId = uuid();
    const { body: wallet } = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: brl('10.00') },
    });
    const bet = (amount: string, ext: string) =>
      api.request('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `provider-a:${ext}` },
        body: {
          providerId: 'provider-a',
          externalTransactionId: ext,
          playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: brl(amount),
        },
      });
    const ext = `m-${uuid()}`;
    await bet('4.00', ext);
    await bet('4.00', ext); // replay
    await bet('99.00', `m-${uuid()}`); // rejected
    await api.request('POST', `/wallets/${wallet.id}/reconciliation`);

    const after = await scrape();
    const delta = (name: string, labels: Record<string, string> = {}) =>
      sample(after, name, labels) - sample(before, name, labels);

    expect(delta('wager_transactions_total', { status: 'PROCESSED', kind: 'BET', channel: 'http' })).toBe(1);
    expect(delta('wager_transactions_total', { status: 'REJECTED', kind: 'BET', channel: 'http' })).toBe(1);
    expect(
      delta('wager_transactions_total', { status: 'PROCESSED', kind: 'OPENING', channel: 'internal' }),
    ).toBe(1);
    expect(delta('wager_duplicates_total', { source: 'idempotency-key' })).toBe(1);
    expect(delta('wager_processing_duration_seconds_count', { channel: 'http' })).toBe(3);
    expect(delta('wallet_reconciliations_total', { result: 'consistent' })).toBe(1);
    // Relay is disabled in tests: the committed events are pending, so lag is measurable.
    expect(sample(after, 'outbox_pending_messages')).toBeGreaterThanOrEqual(5);
    expect(sample(after, 'outbox_lag_seconds')).toBeGreaterThan(0);
    for (const name of [
      'sqs_dlq_messages',
      'wager_pending_reference_transactions',
      'process_cpu_seconds_total',
    ]) {
      expect(after).toContain(`# TYPE ${name}`);
    }
  });

  it('counts lock conflicts (a request that hit lock_timeout)', async () => {
    const before = sample(await scrape(), 'db_lock_conflicts_total', { kind: 'lock_timeout' });
    const playerId = uuid();
    const { body: wallet } = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: brl('10.00') },
    });

    const res = await api.withRowLock('wallets', wallet.id, () =>
      api.request('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `provider-a:lock-${wallet.id}` },
        body: {
          providerId: 'provider-a',
          externalTransactionId: `lock-${wallet.id}`,
          playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: brl('1.00'),
        },
      }),
    );

    expect(res.status).toBe(503);
    expect(sample(await scrape(), 'db_lock_conflicts_total', { kind: 'lock_timeout' }) - before).toBe(1);
  });
});

describe('readiness when a dependency is down', () => {
  it('returns 503 and says which check failed', async () => {
    await api.close();
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens there
    api = await createHttpTestApp();
    const res = await api.request('GET', '/health/ready');
    expect(res).toMatchObject({
      status: 503,
      body: { status: 'unavailable', checks: { database: 'up', sqs: 'down' } },
    });
    expect((await api.request('GET', '/health/live')).status).toBe(200); // alive, just not ready
  });
});
