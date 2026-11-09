import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHttpTestApp, type HttpTestApp } from './support/http-app';
import { inconsistentWallets, uuid } from './support/test-app';

let api: HttpTestApp;
const corruptedWallets: string[] = [];

const originalLockTimeout = process.env.DB_LOCK_TIMEOUT_MS;

beforeAll(async () => {
  process.env.DB_LOCK_TIMEOUT_MS = '300'; // read when the app boots
  api = await createHttpTestApp();
});
afterAll(async () => {
  // Only the wallet corrupted on purpose by the reconciliation test may diverge.
  expect(await inconsistentWallets(api.sql)).toEqual(corruptedWallets);
  await api.close();
  process.env.DB_LOCK_TIMEOUT_MS = originalLockTimeout;
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
let seq = 0;

async function openWallet(amount = '100.00') {
  const playerId = uuid();
  const { body } = await api.request('POST', '/wallets', { body: { playerId, initialBalance: brl(amount) } });
  return { walletId: body.id as string, playerId };
}

function wager(owner: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = `http-${Date.now()}-${++seq}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: owner.playerId,
    walletId: owner.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (
  body: Record<string, unknown>,
  key: string | null = `provider-a:${body.externalTransactionId}`,
) =>
  api.request('POST', '/wagering/transactions', {
    body,
    headers: key === null ? {} : { 'idempotency-key': key },
  });

describe('POST /wallets', () => {
  it('201 with the README contract', async () => {
    const playerId = uuid();
    const res = await api.request('POST', '/wallets', { body: { playerId, initialBalance: brl('1000.00') } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });
  });

  it('409 for a second wallet of the same player and currency', async () => {
    const playerId = uuid();
    await api.request('POST', '/wallets', { body: { playerId, initialBalance: brl('1.00') } });
    const res = await api.request('POST', '/wallets', { body: { playerId, initialBalance: brl('1.00') } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it.each([
    [
      'amount as JSON number',
      { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } },
      'INVALID_PAYLOAD',
    ],
    ['more than 2 decimals', { playerId: uuid(), initialBalance: brl('1.005') }, 'INVALID_MONEY'],
    ['negative amount', { playerId: uuid(), initialBalance: brl('-1.00') }, 'INVALID_MONEY'],
    ['playerId not a UUID', { playerId: 'p-1', initialBalance: brl('1.00') }, 'INVALID_PAYLOAD'],
    ['unknown field', { playerId: uuid(), initialBalance: brl('1.00'), admin: true }, 'INVALID_PAYLOAD'],
  ])('400 for %s', async (_label, body, code) => {
    const res = await api.request('POST', '/wallets', { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });
});

describe('POST /wagering/transactions: status per outcome', () => {
  it('201 when applied, 200 with idempotentReplay on resend', async () => {
    const owner = await openWallet('1000.00');
    const body = wager(owner);

    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });

    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('422 with failureCode for a business rejection; resend replays the same 422', async () => {
    const owner = await openWallet('10.00');
    const body = wager(owner, { money: brl('50.00') });

    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
    const again = await submit(body);
    expect(again.status).toBe(422);
    expect(again.body.idempotentReplay).toBe(true);
  });

  it('202 when accepted but waiting for its reference', async () => {
    const owner = await openWallet();
    const res = await submit(
      wager(owner, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet-here' }),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  it('422 WALLET_NOT_FOUND for an unknown wallet (not persisted)', async () => {
    const res = await submit(wager({ walletId: uuid(), playerId: uuid() }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'REJECTED',
      failureCode: 'WALLET_NOT_FOUND',
      idempotentReplay: false,
    });
  });

  it('409 IDEMPOTENCY_KEY_CONFLICT for the same key with another payload', async () => {
    const owner = await openWallet();
    const body = wager(owner);
    await submit(body);
    const res = await submit({ ...body, money: brl('26.00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('409 EXTERNAL_TRANSACTION_CONFLICT for the same transaction under another key', async () => {
    const owner = await openWallet();
    const body = wager(owner);
    await submit(body);
    const res = await submit(body, 'other-key');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  it.each([
    ['missing Idempotency-Key', {}, null, 'INVALID_IDEMPOTENCY_KEY'],
    ['OPENING submitted by a provider', { kind: 'OPENING' }, undefined, 'INVALID_PAYLOAD'],
    ['REFUND without reference', { kind: 'REFUND' }, undefined, 'INVALID_WAGER_TRANSACTION'],
    ['amount in scientific notation', { money: brl('1e3') }, undefined, 'INVALID_MONEY'],
    ['walletId not a UUID', { walletId: 'w-1' }, undefined, 'INVALID_PAYLOAD'],
    ['missing money', { money: undefined }, undefined, 'INVALID_PAYLOAD'],
  ])('400 for %s', async (_label, overrides, key, code) => {
    const owner = await openWallet();
    const body = wager(owner, overrides);
    const res = await submit(body, key === null ? null : `provider-a:${body.externalTransactionId}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('503 with Retry-After when the wallet lock cannot be acquired in time', async () => {
    const owner = await openWallet();
    // Another transaction holds the wallet row lock for longer than DB_LOCK_TIMEOUT_MS (300ms here).
    const res = await api.withRowLock('wallets', owner.walletId, () => submit(wager(owner)));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    // Nothing was persisted: the provider can safely resend the same request.
    const retry = await submit(wager(owner));
    expect(retry.status).toBe(201);
  });
});

describe('GET endpoints', () => {
  it('GET /wallets/:id returns the wallet; 404 if unknown; 400 if not a UUID', async () => {
    const owner = await openWallet('42.00');
    const ok = await api.request('GET', `/wallets/${owner.walletId}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      id: owner.walletId,
      playerId: owner.playerId,
      balance: brl('42.00'),
      version: 1,
    });

    expect((await api.request('GET', `/wallets/${uuid()}`)).status).toBe(404);
    expect((await api.request('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  it('GET /wallets/:id/ledger paginates newest first with a stable opaque cursor', async () => {
    const owner = await openWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00', '4.00']) await submit(wager(owner, { money: brl(amount) }));

    const amounts: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const res = await api.request('GET', `/wallets/${owner.walletId}/ledger${query}`);
      expect(res.status).toBe(200);
      amounts.push(...res.body.items.map((i: { money: { amount: string } }) => i.money.amount));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(amounts).toEqual(['4.00', '3.00', '2.00', '1.00', '100.00']);
    expect(pages).toBe(3);
  });

  it('ledger rejects a forged cursor and an out-of-range limit', async () => {
    const owner = await openWallet();
    const forged = await api.request('GET', `/wallets/${owner.walletId}/ledger?cursor=abc`);
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('INVALID_CURSOR');
    expect((await api.request('GET', `/wallets/${owner.walletId}/ledger?limit=1000`)).status).toBe(400);
  });

  it('GET transaction by id and by provider + external id', async () => {
    const owner = await openWallet();
    const body = wager(owner);
    const { body: created } = await submit(body);

    const byId = await api.request('GET', `/wagering/transactions/${created.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.transactionId,
      externalTransactionId: body.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: brl('25.00'),
      balance: brl('75.00'),
    });

    const byExternal = await api.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.request('GET', `/wagering/transactions/${uuid()}`)).status).toBe(404);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  it('reports a consistent wallet', async () => {
    const owner = await openWallet('100.00');
    await submit(wager(owner, { money: brl('25.00') }));

    const res = await api.request('POST', `/wallets/${owner.walletId}/reconciliation`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: owner.walletId,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('flags a divergence and does not fix it', async () => {
    const owner = await openWallet('100.00');
    await api.sql('UPDATE wallets SET balance = 90.00 WHERE id = ?', [owner.walletId]); // simulated corruption
    corruptedWallets.push(owner.walletId);

    const res = await api.request('POST', `/wallets/${owner.walletId}/reconciliation`);

    expect(res.body).toMatchObject({
      consistent: false,
      difference: brl('-10.00'),
      calculatedBalance: brl('100.00'),
    });
    const [wallet] = await api.sql<{ balance: string }>(
      'SELECT balance::text AS balance FROM wallets WHERE id = ?',
      [owner.walletId],
    );
    expect(wallet?.balance).toBe('90.00');
  });
});

describe('cross-cutting', () => {
  it('echoes X-Correlation-Id and includes it in error bodies', async () => {
    const res = await api.request('GET', `/wallets/${uuid()}`, {
      headers: { 'x-correlation-id': 'trace-42' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('trace-42');
    expect(res.body).toEqual({
      error: { code: 'WALLET_NOT_FOUND', message: expect.any(String) },
      correlationId: 'trace-42',
    });
  });
});
