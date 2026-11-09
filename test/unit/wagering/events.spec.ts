import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/modules/wagering/domain/events/wager-transaction-events';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { WalletBalanceChanged } from '../../../src/modules/wallets/domain/events/wallet-balance-changed.event';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import type { EventContext } from '../../../src/shared/domain/integration-event';
import { at, brl, makeTx, makeWallet, settle, T0 } from '../support/builders';

const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 };

describe('integration events', () => {
  it('serialize a versioned envelope with eventType and version fixed by the class', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = makeTx({ money: brl('25.00') });
    settle({ transaction: bet, wallet, at: at(1) });

    const json = WagerTransactionProcessed.from(bet, ctx).toJSON();

    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: bet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
    });
    expect(json.data).toMatchObject({
      transactionId: bet.id,
      kind: Kind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      processedAt: at(1).toISOString(),
    });
  });

  it('carry MoneyProps (strings), never Money instances: the payload is stable JSON', () => {
    const wallet = makeWallet();
    const bet = makeTx();
    const outcome = settle({ transaction: bet, wallet });
    const entry = 'ledgerEntry' in outcome ? outcome.ledgerEntry : undefined;
    if (!entry) throw new Error('expected a ledger entry');

    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const roundTrip = JSON.parse(JSON.stringify(event));

    expect(roundTrip).toEqual(event.toJSON());
    expect(roundTrip.data).toEqual({
      walletId: wallet.id,
      transactionId: bet.id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('omits causationId when absent and freezes data', () => {
    const wallet = makeWallet({ balance: '1.00' });
    const bet = makeTx({ money: brl('5.00') });
    settle({ transaction: bet, wallet });

    const event = WagerTransactionRejected.from(bet, { ...ctx, causationId: undefined });

    expect(event.toJSON()).not.toHaveProperty('causationId');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  it('pending-reference event exposes the retry schedule', () => {
    const refund = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    settle({ transaction: refund, wallet: makeWallet(), at: at(0) });

    expect(WagerTransactionPendingReference.from(refund, ctx).data).toMatchObject({
      referenceExternalTransactionId: 'bet-1',
      attempts: 1,
      nextCheckAt: at(1).toISOString(),
    });
  });

  it('refuse to describe a transaction in the wrong state', () => {
    const pending = makeTx();
    expect(() => WagerTransactionProcessed.from(pending, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx)).toThrow(InvariantViolationError);
  });
});
