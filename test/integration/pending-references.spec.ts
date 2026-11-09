import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ProcessPendingReferencesUseCase } from '../../src/modules/wagering/application/use-cases/process-pending-references.use-case';
import { WagerSettlementService } from '../../src/modules/wagering/application/wager-settlement.service';
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
 * Out-of-order references (challenge §7.1, test 7) on the real database. Backoff shrunk to
 * 50-100 ms and 3 attempts so the whole lifecycle fits in a test.
 */
let app: TestApp;
let pending: ProcessPendingReferencesUseCase;
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.PENDING_REFERENCE_BASE_DELAY_MS = '50';
  process.env.PENDING_REFERENCE_MAX_DELAY_MS = '100';
  process.env.PENDING_REFERENCE_MAX_ATTEMPTS = '3';
  app = await createTestApp();
  pending = app.get<ProcessPendingReferencesUseCase>(ProcessPendingReferencesUseCase);
});
afterAll(async () => {
  expect(await inconsistentWallets(app.sql)).toEqual([]);
  await app.close();
  process.env = savedEnv;
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(amount = '100.00') {
  const playerId = uuid();
  const wallet = await app.openWallet.execute({
    playerId,
    initialBalance: brl(amount),
    correlationId: 'test',
  });
  return { walletId: wallet.id, playerId };
}

const statusOf = async (transactionId: string) =>
  (
    await app.sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
      'SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ?',
      [transactionId],
    )
  )[0];

const eventsOf = async (transactionId: string) =>
  (
    await app.sql<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, event_type`,
      [transactionId],
    )
  ).map((e) => e.event_type);

/** Runs the worker until nothing is due (bounded). */
async function drainDue(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    const run = await pending.execute(50);
    if (run.handled === 0 && run.skipped === 0) return;
  }
}

describe('PENDING_REFERENCE retries', () => {
  it('ROLLBACK delivered before its BET settles once the BET arrives (test 7)', async () => {
    const owner = await newWallet('100.00');
    const bet = wagerCommand({ ...owner, money: brl('30.00') });
    const rollbackCommand = wagerCommand({
      ...owner,
      kind: 'ROLLBACK',
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = await app.processWager.execute(rollbackCommand);
    expect(rollback.status).toBe(Status.PendingReference);

    await app.processWager.execute(bet);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '70.00',
      rebuilt: '70.00',
      entries: 2,
    });

    await drainDue();

    expect((await statusOf(rollback.transactionId))?.status).toBe('PROCESSED');
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '100.00',
      rebuilt: '100.00',
      entries: 3,
    });
    expect(await eventsOf(rollback.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    // Resending the ROLLBACK now replays its final state.
    expect(await app.processWager.execute(rollbackCommand)).toMatchObject({
      status: Status.Processed,
      balance: brl('100.00'),
      idempotentReplay: true,
    });
  });

  it('processing the reference wakes its dependents immediately (no waiting for the backoff)', async () => {
    const owner = await newWallet();
    const bet = wagerCommand({ ...owner, money: brl('10.00') });
    const refund = await app.processWager.execute(
      wagerCommand({
        ...owner,
        kind: 'REFUND',
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    // Push the next check far into the future: only the wake-up can make it due now.
    await app.sql(
      `UPDATE wager_transactions SET next_reference_check_at = now() + interval '1 hour' WHERE id = ?`,
      [refund.transactionId],
    );

    await app.processWager.execute(bet);
    const run = await pending.execute(50);

    expect(run.outcomes.PROCESSED).toBeGreaterThanOrEqual(1);
    expect((await statusOf(refund.transactionId))?.status).toBe('PROCESSED');
  });

  it('a transaction not due yet is left alone', async () => {
    const owner = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand({
        ...owner,
        kind: 'REFUND',
        money: brl('5.00'),
        referenceExternalTransactionId: `never-${uuid()}`,
      }),
    );
    await app.sql(
      `UPDATE wager_transactions SET next_reference_check_at = now() + interval '1 hour' WHERE id = ?`,
      [refund.transactionId],
    );

    await pending.execute(50);

    expect(await statusOf(refund.transactionId)).toEqual({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      reference_attempts: 1,
    });
  });

  it('gives up with REFERENCE_NOT_FOUND after the attempts are exhausted, and publishes the rejection', async () => {
    const owner = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand({
        ...owner,
        kind: 'REFUND',
        money: brl('5.00'),
        referenceExternalTransactionId: `never-${uuid()}`,
      }),
    );

    for (let i = 0; i < 6 && (await statusOf(refund.transactionId))?.status === 'PENDING_REFERENCE'; i++) {
      await Bun.sleep(120); // longer than the max backoff
      await pending.execute(50);
    }

    expect(await statusOf(refund.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: FailureCode.ReferenceNotFound,
      reference_attempts: 3,
    });
    // PendingReference announced once (not on every retry), then the rejection.
    expect(await eventsOf(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '100.00',
      rebuilt: '100.00',
      entries: 1,
    });
  });

  it('a late reversal that would overdraw is REJECTED with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const owner = await newWallet('0.00');
    const win = wagerCommand({ ...owner, kind: 'WIN', money: brl('50.00') });
    const rollback = await app.processWager.execute(
      wagerCommand({
        ...owner,
        kind: 'ROLLBACK',
        money: brl('50.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    await app.processWager.execute(win);
    await app.processWager.execute(wagerCommand({ ...owner, money: brl('45.00') })); // prize spent

    await drainDue();

    expect(await statusOf(rollback.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: FailureCode.ReversalInsufficientFunds,
    });
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '5.00',
      rebuilt: '5.00',
      entries: 2,
    });
  });

  it('resolves chains: ROLLBACK → WIN → BET arriving in reverse order', async () => {
    const owner = await newWallet('100.00');
    const bet = wagerCommand({ ...owner, money: brl('20.00') });
    const win = wagerCommand({
      ...owner,
      kind: 'WIN',
      money: brl('60.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = wagerCommand({
      ...owner,
      kind: 'ROLLBACK',
      money: brl('60.00'),
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const r = await app.processWager.execute(rollback);
    const w = await app.processWager.execute(win);
    await app.processWager.execute(bet);
    await drainDue();

    expect((await statusOf(w.transactionId))?.status).toBe('PROCESSED');
    expect((await statusOf(r.transactionId))?.status).toBe('PROCESSED');
    // 100 - 20 (bet) + 60 (win) - 60 (rollback of win) = 80
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '80.00',
      rebuilt: '80.00',
      entries: 4,
    });
  });

  it('two workers running concurrently settle each pending transaction exactly once', async () => {
    const owners = await Promise.all(Array.from({ length: 4 }, () => newWallet('100.00')));
    const bets = owners.flatMap((owner) =>
      Array.from({ length: 5 }, () => ({ owner, bet: wagerCommand({ ...owner, money: brl('10.00') }) })),
    );
    const refunds = await Promise.all(
      bets.map(({ owner, bet }) =>
        app.processWager.execute(
          wagerCommand({
            ...owner,
            kind: 'REFUND',
            money: brl('10.00'),
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
    );
    for (const { bet } of bets) await app.processWager.execute(bet);

    const runs = await Promise.all([pending.execute(50), pending.execute(50), pending.execute(50)]);
    await drainDue();

    const handled = runs.reduce((sum, r) => sum + (r.outcomes.PROCESSED ?? 0), 0);
    expect(handled).toBeLessThanOrEqual(refunds.length);
    for (const refund of refunds) expect((await statusOf(refund.transactionId))?.status).toBe('PROCESSED');
    for (const owner of owners) {
      // 5 bets of 10 debited, 5 refunds of 10 credited back, each exactly once.
      expect(await ledgerInvariant(app, owner.walletId)).toEqual({
        stored: '100.00',
        rebuilt: '100.00',
        entries: 11,
      });
    }
  });
});

describe('permanent failure during a retry', () => {
  it('marks the transaction FAILED (PROCESSING_FAILED) instead of retrying it forever', async () => {
    // Runs last: it boots its own app, which rebuilds the schema.
    await app.close();
    const broken = await createTestApp((builder) =>
      builder.overrideProvider(WagerSettlementService).useValue({
        settle: async () => {
          throw new Error('bug: invariant broken');
        },
      }),
    );
    try {
      const playerId = uuid();
      const walletId = uuid();
      await broken.sql(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 10.00, 1, now(), now())`,
        [walletId, playerId],
      );
      const id = uuid();
      await broken.sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
           status, reference_attempts, next_reference_check_at, created_at)
         VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'r', 'g', 'REFUND', 1.00, 'BRL', 'missing',
           'PENDING_REFERENCE', 1, now() - interval '1 second', now())`,
        [id, `ext-${id}`, `key-${id}`, walletId, playerId],
      );

      const worker = broken.get<ProcessPendingReferencesUseCase>(ProcessPendingReferencesUseCase);
      const run = await worker.execute(10);

      expect(run.failed).toBe(1);
      const [row] = await broken.sql('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [
        id,
      ]);
      expect(row).toEqual({ status: 'FAILED', failure_code: FailureCode.ProcessingFailed });
      expect((await worker.execute(10)).handled).toBe(0); // not picked again
    } finally {
      await broken.close();
      app = await createTestApp(); // keep afterAll's close() valid
    }
  });
});
