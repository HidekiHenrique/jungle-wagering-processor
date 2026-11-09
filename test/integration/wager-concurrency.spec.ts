import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import {
  createTestApp,
  inconsistentWallets,
  ledgerInvariant,
  type TestApp,
  uuid,
  wagerCommand,
} from './support/test-app';

/**
 * Real concurrency: every operation runs in its own transaction on its own pooled connection,
 * started together with Promise.all. Postgres sees them interleaved; nothing is mocked.
 */
let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  expect(await inconsistentWallets(app.sql)).toEqual([]);
  await app.close();
});

async function newWallet(amount: string) {
  const playerId = uuid();
  const wallet = await app.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
  });
  return { walletId: wallet.id, playerId };
}

const count = async (query: string, params: unknown[]) =>
  Number((await app.sql<{ n: string }>(query, params))[0]?.n);

describe('concurrency (challenge §13)', () => {
  it('1. the same bet sent 50 times in parallel debits exactly once', async () => {
    const owner = await newWallet('1000.00');
    const command = wagerCommand({ ...owner, money: { amount: '25.00', currency: 'BRL' } });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => app.processWager.execute({ ...command })),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === Status.Processed && r.balance?.amount === '975.00')).toBe(true);

    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '975.00',
      rebuilt: '975.00',
      entries: 2,
    });
    const debitEvents = await count(
      `SELECT count(*) AS n FROM outbox_messages WHERE event_type = 'WalletBalanceChanged' AND payload->'data'->>'direction' = 'DEBIT' AND aggregate_id = ?`,
      [owner.walletId],
    );
    expect(debitEvents).toBe(1);
  });

  it('2. two bets of 80.00 on 100.00 at the same time: one PROCESSED, one REJECTED, 20.00 left', async () => {
    const owner = await newWallet('100.00');
    const bets = [1, 2].map(() => wagerCommand({ ...owner, money: { amount: '80.00', currency: 'BRL' } }));

    const results = await Promise.all(bets.map((bet) => app.processWager.execute(bet)));

    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    const rejected = results.find((r) => r.status === Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected?.balance?.amount).toBe('20.00');
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '20.00',
      rebuilt: '20.00',
      entries: 2,
    });

    // Retrying both (provider resend) replays the original outcomes and never debits again.
    const retries = await Promise.all(bets.map((bet) => app.processWager.execute(bet)));
    expect(retries.every((r) => r.idempotentReplay)).toBe(true);
    expect(retries.map((r) => r.status)).toEqual(results.map((r) => r.status));
    expect(
      await count(
        `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [owner.walletId],
      ),
    ).toBe(1);
  });

  it('a burst of 40 different bets on one hot wallet never overdraws it', async () => {
    const owner = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.processWager.execute(wagerCommand({ ...owner, money: { amount: '7.00', currency: 'BRL' } })),
      ),
    );

    // 100 / 7 = 14 bets fit; 15 * 7 = 105 would overdraw.
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(14);
    expect(results.filter((r) => r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(26);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '2.00',
      rebuilt: '2.00',
      entries: 15,
    });
    const [wallet] = await app.sql<{ version: number }>('SELECT version FROM wallets WHERE id = ?', [
      owner.walletId,
    ]);
    expect(wallet?.version).toBe(15); // 1 + 14 debits
  });

  it('3. different wallets are processed in parallel, each one consistent', async () => {
    const owners = await Promise.all(Array.from({ length: 8 }, () => newWallet('50.00')));
    const operations = owners.flatMap((owner) =>
      Array.from({ length: 5 }, () =>
        app.processWager.execute(wagerCommand({ ...owner, money: { amount: '10.00', currency: 'BRL' } })),
      ),
    );

    const results = await Promise.all(operations);

    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    for (const owner of owners) {
      expect(await ledgerInvariant(app, owner.walletId)).toEqual({
        stored: '0.00',
        rebuilt: '0.00',
        entries: 6,
      });
    }
  });

  it('the same SQS message delivered concurrently is applied once (inbox)', async () => {
    const owner = await newWallet('100.00');
    const command = wagerCommand({
      ...owner,
      inbox: { consumerName: 'wager-transactions', messageId: `msg-${uuid()}`, payloadHash: 'h' },
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.processWager.execute({ ...command })),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(
      await count('SELECT count(*) AS n FROM inbox_messages WHERE message_id = ?', [
        command.inbox?.messageId,
      ]),
    ).toBe(1);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '75.00',
      rebuilt: '75.00',
      entries: 2,
    });
  });
});
