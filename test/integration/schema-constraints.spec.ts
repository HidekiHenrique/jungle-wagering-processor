import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp, type TestApp, uuid } from './support/test-app';

/**
 * The schema is the last line of defense (challenge §5 item 9): these tests write straight SQL,
 * bypassing every application check, and expect Postgres itself to refuse.
 */
let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const exec = (query: string, params: unknown[] = []) => app.sql(query, params);

async function insertWallet(balance = '100.00', overrides: { playerId?: string; currency?: string } = {}) {
  const id = uuid();
  await exec(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, now(), now())`,
    [id, overrides.playerId ?? uuid(), overrides.currency ?? 'BRL', balance],
  );
  return id;
}

interface TxOverrides {
  kind?: string;
  status?: string;
  providerId?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  balanceAfter?: string | null;
}

async function insertTransaction(walletId: string, o: TxOverrides = {}) {
  const id = uuid();
  const status = o.status ?? 'PROCESSED';
  await exec(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, balance_after, reference_attempts, created_at, processed_at)
     VALUES (?, ?, ?, ?, 'h', ?, ?, 'r', 'g', ?, 10.00, 'BRL', ?, ?, ?, ?, ?, 0, now(), now())`,
    [
      id,
      o.providerId ?? 'provider-a',
      `ext-${id}`,
      `key-${id}`,
      walletId,
      uuid(),
      o.kind ?? 'BET',
      o.referenceExternalTransactionId ?? null,
      o.referenceTransactionId ?? null,
      status,
      o.failureCode ?? null,
      o.balanceAfter === undefined ? (status === 'PROCESSED' ? '90.00' : null) : o.balanceAfter,
    ],
  );
  return id;
}

async function insertEntry(
  walletId: string,
  transactionId: string,
  e: { direction?: string; amount?: string; before?: string; after?: string; currency?: string } = {},
) {
  await exec(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
       balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      uuid(),
      walletId,
      transactionId,
      e.direction ?? 'DEBIT',
      e.amount ?? '10.00',
      e.currency ?? 'BRL',
      e.before ?? '100.00',
      e.after ?? '90.00',
    ],
  );
}

describe('wallets', () => {
  it('balance can never be negative', async () => {
    const id = await insertWallet('5.00');
    await expect(exec('UPDATE wallets SET balance = -0.01 WHERE id = ?', [id])).rejects.toThrow(
      'check constraint',
    );
  });

  it('one wallet per player and currency', async () => {
    const playerId = uuid();
    await insertWallet('0.00', { playerId });
    await expect(insertWallet('0.00', { playerId })).rejects.toThrow('wallets_player_currency_key');
    await insertWallet('0.00', { playerId, currency: 'USD' }); // other currency is fine
  });
});

describe('ledger', () => {
  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const walletId = await insertWallet();
    await insertEntry(walletId, await insertTransaction(walletId));
    const appendOnly = 'append-only';
    await expect(
      exec('UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?', [walletId]),
    ).rejects.toThrow(appendOnly);
    await expect(exec('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId])).rejects.toThrow(
      appendOnly,
    );
    await expect(exec('TRUNCATE wallet_ledger_entries')).rejects.toThrow(appendOnly);
  });

  it('rejects unbalanced arithmetic', async () => {
    const walletId = await insertWallet();
    await expect(
      insertEntry(walletId, await insertTransaction(walletId), { after: '91.00' }),
    ).rejects.toThrow('wallet_ledger_entries_balanced');
  });

  it('rejects zero amounts and negative balances', async () => {
    const walletId = await insertWallet();
    await expect(
      insertEntry(walletId, await insertTransaction(walletId), { amount: '0.00', after: '100.00' }),
    ).rejects.toThrow('check constraint');
    await expect(
      insertEntry(walletId, await insertTransaction(walletId), { before: '5.00', after: '-5.00' }),
    ).rejects.toThrow('check constraint');
  });

  it('rejects an entry in a currency other than the wallet currency', async () => {
    const walletId = await insertWallet();
    await expect(
      insertEntry(walletId, await insertTransaction(walletId), { currency: 'USD' }),
    ).rejects.toThrow('wallet_ledger_entries_wallet_currency_fkey');
  });

  it('allows at most one entry per transaction', async () => {
    const walletId = await insertWallet();
    const txId = await insertTransaction(walletId);
    await insertEntry(walletId, txId);
    await expect(insertEntry(walletId, txId, { before: '90.00', after: '80.00' })).rejects.toThrow(
      'wallet_ledger_entries_transaction_key',
    );
  });
});

describe('wager_transactions', () => {
  it('a reference can be reverted by at most one PROCESSED REFUND/ROLLBACK', async () => {
    const walletId = await insertWallet();
    const bet = await insertTransaction(walletId);
    const reversal = (kind: string, status = 'PROCESSED') =>
      insertTransaction(walletId, {
        kind,
        status,
        referenceExternalTransactionId: `ext-${bet}`,
        referenceTransactionId: bet,
        failureCode: status === 'REJECTED' ? 'REFERENCE_ALREADY_REVERSED' : null,
      });

    await reversal('REFUND');
    await expect(reversal('ROLLBACK')).rejects.toThrow('wager_transactions_single_reversal');
    await reversal('ROLLBACK', 'REJECTED'); // rejected attempts stay auditable
  });

  it('PENDING can never be committed (deferred constraint trigger)', async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { status: 'PENDING', balanceAfter: null })).rejects.toThrow(
      'cannot be committed as PENDING',
    );
  });

  it('PENDING is allowed inside the transaction as long as it is resolved before COMMIT', async () => {
    const walletId = await insertWallet();
    await app.orm.em.fork().transactional(async (em) => {
      const id = uuid();
      await em.execute(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_attempts, created_at)
         VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', 0, now())`,
        [id, `ext-${id}`, `key-${id}`, walletId, uuid()],
      );
      await em.execute(
        `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = now() WHERE id = ?`,
        [id],
      );
    });
  });

  it('OPENING only under the internal provider, and the internal provider only for OPENING', async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { kind: 'OPENING' })).rejects.toThrow(
      'wager_transactions_opening_is_internal',
    );
    await expect(insertTransaction(walletId, { providerId: '__internal__' })).rejects.toThrow(
      'wager_transactions_opening_is_internal',
    );
  });

  it('keeps status and outcome fields coherent', async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { status: 'REJECTED' })).rejects.toThrow(
      'wager_transactions_failure_code_iff_failed',
    );
    await expect(insertTransaction(walletId, { balanceAfter: null })).rejects.toThrow(
      'wager_transactions_processed_has_outcome',
    );
    await expect(
      insertTransaction(walletId, { kind: 'REFUND', referenceExternalTransactionId: 'x' }),
    ).rejects.toThrow('wager_transactions_processed_reversal_resolved');
    // REJECTED, so that only the missing reference is wrong.
    await expect(
      insertTransaction(walletId, {
        kind: 'ROLLBACK',
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
      }),
    ).rejects.toThrow('wager_transactions_reversal_has_reference');
  });
});

describe('inbox', () => {
  it('deduplicates by (consumer_name, message_id)', async () => {
    const insert = (consumer: string) =>
      exec(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, 'm-1', 'h', now())`,
        [consumer],
      );
    await insert('consumer-a');
    await expect(insert('consumer-a')).rejects.toThrow('duplicate key');
    await insert('consumer-b'); // another consumer may process the same message
  });
});
