import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { OUTBOX_REPOSITORY } from '../../src/modules/messaging/application/ports/outbox.repository';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '../../src/modules/wagering/application/errors';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { InvalidWagerTransactionError } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction-status';
import { WalletAlreadyExistsError } from '../../src/modules/wallets/application/ports/wallet.repository';
import { InvalidMoneyError } from '../../src/shared/domain/money';
import { createTestApp, ledgerInvariant, type TestApp, uuid, wagerCommand } from './support/test-app';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
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

const rows = (table: string, where: string, params: unknown[]) =>
  app.sql(`SELECT * FROM ${table} WHERE ${where}`, params);

describe('OpenWallet', () => {
  it('creates wallet, OPENING transaction, CREDIT entry and events in one transaction', async () => {
    const playerId = uuid();
    const result = await app.openWallet.execute({
      playerId,
      initialBalance: brl('1000.00'),
      correlationId: 'c-1',
    });

    expect(result).toMatchObject({ playerId, balance: brl('1000.00'), version: 1 });
    expect(await ledgerInvariant(app, result.id)).toEqual({
      stored: '1000.00',
      rebuilt: '1000.00',
      entries: 1,
    });
    const [opening] = await rows('wager_transactions', 'wallet_id = ?', [result.id]);
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', provider_id: '__internal__' });
    const events = await app.sql<{ event_type: string }>(
      'SELECT event_type FROM outbox_messages WHERE payload->>? = ? ORDER BY event_type',
      ['correlationId', 'c-1'],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('with zero balance creates no OPENING, no entry and no event', async () => {
    const result = await app.openWallet.execute({
      playerId: uuid(),
      initialBalance: brl('0.00'),
      correlationId: 'c-0',
    });
    expect(await ledgerInvariant(app, result.id)).toEqual({ stored: '0.00', rebuilt: '0.00', entries: 0 });
    expect(await rows('wager_transactions', 'wallet_id = ?', [result.id])).toHaveLength(0);
  });

  it('rejects a second wallet for the same player and currency, persisting nothing', async () => {
    const playerId = uuid();
    await app.openWallet.execute({ playerId, initialBalance: brl('10.00'), correlationId: 'c' });
    await expect(
      app.openWallet.execute({ playerId, initialBalance: brl('5.00'), correlationId: 'c' }),
    ).rejects.toThrow(WalletAlreadyExistsError);
    expect(await rows('wallets', 'player_id = ?', [playerId])).toHaveLength(1);
  });
});

describe('ProcessWagerTransaction', () => {
  it('BET: persists outcome, balance_after, ledger entry and the two events', async () => {
    const owner = await newWallet('100.00');
    const command = wagerCommand({ ...owner, money: brl('25.00') });

    const result = await app.processWager.execute(command);

    expect(result).toMatchObject({
      status: Status.Processed,
      balance: brl('75.00'),
      idempotentReplay: false,
    });
    const [tx] = await rows('wager_transactions', 'id = ?', [result.transactionId]);
    expect(tx).toMatchObject({ status: 'PROCESSED', balance_after: '75.00', kind: 'BET' });
    const events = await app.sql<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type`,
      [result.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('LOSS: PROCESSED, no ledger entry, no version change, only WagerTransactionProcessed', async () => {
    const owner = await newWallet('100.00');
    const result = await app.processWager.execute(
      wagerCommand({ ...owner, kind: 'LOSS', money: brl('25.00') }),
    );

    expect(result.status).toBe(Status.Processed);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '100.00',
      rebuilt: '100.00',
      entries: 1,
    });
    const [wallet] = await rows('wallets', 'id = ?', [owner.walletId]);
    expect(wallet?.version).toBe(1);
    const events = await app.sql(
      `SELECT 1 FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`,
      [result.transactionId],
    );
    expect(events).toHaveLength(1);
  });

  it('REFUND then ROLLBACK of the same BET: second is REJECTED (A1), balance credited once', async () => {
    const owner = await newWallet('100.00');
    const bet = wagerCommand({ ...owner, money: brl('40.00'), roundId: 'r-a1' });
    await app.processWager.execute(bet);
    const reverse = (kind: string) =>
      app.processWager.execute(
        wagerCommand({
          ...owner,
          kind,
          money: brl('40.00'),
          roundId: 'r-a1',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

    expect((await reverse('REFUND')).status).toBe(Status.Processed);
    expect(await reverse('ROLLBACK')).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '100.00',
      rebuilt: '100.00',
      entries: 3,
    });
  });

  it('ROLLBACK before its BET is persisted as PENDING_REFERENCE with a scheduled retry', async () => {
    const owner = await newWallet('100.00');
    const result = await app.processWager.execute(
      wagerCommand({
        ...owner,
        kind: 'ROLLBACK',
        money: brl('10.00'),
        referenceExternalTransactionId: 'not-yet',
      }),
    );

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: Status.PendingReference,
      idempotentReplay: false,
    });
    const [tx] = await rows('wager_transactions', 'id = ?', [result.transactionId]);
    expect(tx).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    expect(tx?.next_reference_check_at).toBeTruthy();
    const [event] = await app.sql<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
      [result.transactionId],
    );
    expect(event?.event_type).toBe('WagerTransactionPendingReference');
  });

  it('rejects an unknown wallet without persisting anything', async () => {
    const command = wagerCommand({ walletId: uuid(), playerId: uuid() });
    await expect(app.processWager.execute(command)).rejects.toThrow(WalletNotFoundError);
    expect(
      await rows('wager_transactions', 'external_transaction_id = ?', [command.externalTransactionId]),
    ).toHaveLength(0);
  });

  it('rejects invalid payloads before touching the database', async () => {
    const owner = await newWallet();
    await expect(app.processWager.execute(wagerCommand({ ...owner, money: brl('1.005') }))).rejects.toThrow(
      InvalidMoneyError,
    );
    await expect(app.processWager.execute(wagerCommand({ ...owner, kind: 'OPENING' }))).rejects.toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('idempotency', () => {
  it('replays the original result, including the balance observed back then', async () => {
    const owner = await newWallet('100.00');
    const first = wagerCommand({ ...owner, money: brl('30.00') });
    await app.processWager.execute(first);
    await app.processWager.execute(wagerCommand({ ...owner, money: brl('50.00') }));

    const replay = await app.processWager.execute(first);

    expect(replay).toMatchObject({ status: Status.Processed, balance: brl('70.00'), idempotentReplay: true });
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '20.00',
      rebuilt: '20.00',
      entries: 3,
    });
  });

  it('treats "25" and "25.00" as the same payload (hash of the normalized amount)', async () => {
    const owner = await newWallet();
    const command = wagerCommand({ ...owner, money: brl('25.00') });
    await app.processWager.execute(command);
    expect((await app.processWager.execute({ ...command, money: brl('25') })).idempotentReplay).toBe(true);
  });

  it('same key with a different payload is a conflict, never a replay', async () => {
    const owner = await newWallet();
    const command = wagerCommand({ ...owner, money: brl('10.00') });
    await app.processWager.execute(command);

    await expect(app.processWager.execute({ ...command, money: brl('11.00') })).rejects.toThrow(
      IdempotencyKeyConflictError,
    );
  });

  it('a different key for an existing (provider, externalTransactionId) is a conflict', async () => {
    const owner = await newWallet();
    const command = wagerCommand({ ...owner });
    await app.processWager.execute(command);

    await expect(app.processWager.execute({ ...command, idempotencyKey: 'another-key' })).rejects.toThrow(
      ExternalTransactionConflictError,
    );
  });

  it('the same key is scoped per provider', async () => {
    const owner = await newWallet('100.00');
    const command = wagerCommand({
      ...owner,
      idempotencyKey: 'shared-key',
      externalTransactionId: `x-${uuid()}`,
    });
    await app.processWager.execute(command);

    const other = await app.processWager.execute({ ...command, providerId: 'provider-b' });
    expect(other.idempotentReplay).toBe(false);
    expect(await ledgerInvariant(app, owner.walletId)).toEqual({
      stored: '50.00',
      rebuilt: '50.00',
      entries: 3,
    });
  });
});

describe('atomicity', () => {
  it('a failure after the ledger write rolls back wallet, ledger, transaction and inbox together', async () => {
    const failing = await createTestApp((builder) =>
      builder.overrideProvider(OUTBOX_REPOSITORY).useValue({
        add: async () => {
          throw new Error('outbox unavailable');
        },
      }),
    );
    try {
      const playerId = uuid();
      // Opening also writes to the outbox, so create the wallet directly.
      const walletId = uuid();
      await failing.sql(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 100.00, 1, now(), now())`,
        [walletId, playerId],
      );
      const command = wagerCommand({
        walletId,
        playerId,
        inbox: { consumerName: 'wager-transactions', messageId: `msg-${uuid()}`, payloadHash: 'h' },
      });

      await expect(failing.processWager.execute(command)).rejects.toThrow('outbox unavailable');

      const [wallet] = await failing.sql(
        'SELECT balance::text AS balance, version FROM wallets WHERE id = ?',
        [walletId],
      );
      expect(wallet).toEqual({ balance: '100.00', version: 1 });
      expect(
        await failing.sql('SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]),
      ).toHaveLength(0);
      expect(
        await failing.sql('SELECT 1 FROM wager_transactions WHERE wallet_id = ?', [walletId]),
      ).toHaveLength(0);
      expect(
        await failing.sql('SELECT 1 FROM inbox_messages WHERE message_id = ?', [command.inbox?.messageId]),
      ).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });
});
