import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  INTERNAL_PROVIDER_ID,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/modules/wagering/domain/wager-transaction-status';
import { LedgerDirection } from '../../../src/modules/wallets/domain/ledger-direction';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { at, brl, makeTx, PENDING_POLICY, T0 } from '../support/builders';

describe('WagerTransaction.create', () => {
  it('is born PENDING with no outcome', () => {
    const tx = makeTx();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  it.each([
    ['OPENING from a provider', { kind: Kind.Opening }, 'OPENING is internal'],
    ['the reserved internal provider', { providerId: INTERNAL_PROVIDER_ID }, 'providerId is reserved'],
    ['REFUND without reference', { kind: Kind.Refund }, 'REFUND requires referenceExternalTransactionId'],
    [
      'ROLLBACK without reference',
      { kind: Kind.Rollback },
      'ROLLBACK requires referenceExternalTransactionId',
    ],
    ['BET with a reference', { referenceExternalTransactionId: 'x' }, 'BET does not accept a reference'],
    ['zero BET', { money: brl('0.00') }, 'BET amount must be greater than zero'],
    [
      'self reference',
      { kind: Kind.Win, externalTransactionId: 'a', referenceExternalTransactionId: 'a' },
      'itself',
    ],
    ['empty roundId', { roundId: ' ' }, 'roundId is required'],
    ['oversized externalTransactionId', { externalTransactionId: 'x'.repeat(129) }, 'at most 128'],
    ['unknown kind', { kind: 'JACKPOT' as Kind }, 'unknown kind "JACKPOT"'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => makeTx(overrides)).toThrow(InvalidWagerTransactionError);
    expect(() => makeTx(overrides)).toThrow(message);
  });

  it('accepts LOSS and WIN with zero amount, with or without a reference', () => {
    expect(makeTx({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    expect(makeTx({ kind: Kind.Loss, money: brl('25.00') }).affectsBalance()).toBe(false);
    expect(
      makeTx({ kind: Kind.Win, money: brl('0.00'), referenceExternalTransactionId: 'b' }).affectsBalance(),
    ).toBe(false);
    expect(makeTx({ kind: Kind.Win, money: brl('10.00') }).affectsBalance()).toBe(true);
  });
});

describe('WagerTransaction.opening', () => {
  it('builds the internal OPENING credit under the reserved provider', () => {
    const tx = WagerTransaction.opening({
      id: 'o',
      walletId: 'w',
      playerId: 'p',
      money: brl('10.00'),
      createdAt: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('requires a positive amount', () => {
    expect(() =>
      WagerTransaction.opening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('0'), createdAt: T0 }),
    ).toThrow(InvariantViolationError);
  });
});

describe('WagerTransaction transitions', () => {
  it('PENDING → PROCESSED records outcome, balance and time', () => {
    const tx = makeTx();
    tx.markProcessed({ at: at(1), balanceAfter: brl('75.00') });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balanceAfter?.amount).toBe('75.00');
    expect(tx.processedAt).toEqual(at(1));
  });

  it('PENDING → REJECTED records the failure code', () => {
    const tx = makeTx();
    tx.reject(FailureCode.InsufficientFunds, { at: at(1), balanceAfter: brl('10.00') });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('PENDING → PENDING_REFERENCE → PENDING_REFERENCE counts attempts with backoff', () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(at(0), PENDING_POLICY);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceCheckAt).toEqual(at(1));
    tx.markPendingReference(at(10), PENDING_POLICY);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceCheckAt).toEqual(at(12));
  });

  it('PENDING_REFERENCE → FAILED', () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(at(0), PENDING_POLICY);
    tx.fail(FailureCode.ProcessingFailed, at(5));
    expect(tx.status).toBe(Status.Failed);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  it('cannot wait for a reference it does not have', () => {
    expect(() => makeTx().markPendingReference(at(0), PENDING_POLICY)).toThrow(InvariantViolationError);
  });

  it('cannot process a reversal without its resolved reference', () => {
    const tx = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed({ at: at(1), balanceAfter: brl('1.00') })).toThrow(InvariantViolationError);
  });

  describe.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed({ at: at(1), balanceAfter: brl('1.00') })],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, { at: at(1) })],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, at(1))],
  ])('terminal state %s', (_status, settleTo) => {
    it('rejects every further transition as a programming error', () => {
      const tx = makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
      settleTo(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed({ at: at(2), balanceAfter: brl('1.00') })).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.reject(FailureCode.InsufficientFunds, { at: at(2) })).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.ProcessingFailed, at(2))).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(at(2), PENDING_POLICY)).toThrow(InvalidTransactionStateError);
    });
  });
});

describe('WagerTransaction queries', () => {
  it('matches only the original payload hash (same key + different payload = conflict)', () => {
    const tx = makeTx({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  it('flags which kinds require a reference', () => {
    expect(makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).requiresReference()).toBe(true);
    expect(makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' }).requiresReference()).toBe(
      true,
    );
    expect(makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'b' }).requiresReference()).toBe(false);
    expect(makeTx().requiresReference()).toBe(false);
  });

  it('derives ledger direction; ROLLBACK inverts its reference', () => {
    const bet = makeTx();
    const win = makeTx({ kind: Kind.Win });
    const refund = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => makeTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });
});
