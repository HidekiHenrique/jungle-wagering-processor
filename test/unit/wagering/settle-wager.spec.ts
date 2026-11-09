import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import type { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/modules/wagering/domain/wager-transaction-status';
import { LedgerDirection } from '../../../src/modules/wallets/domain/ledger-direction';
import { Wallet } from '../../../src/modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../../src/modules/wallets/domain/wallet-ledger-entry';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';
import { at, brl, makeTx, makeWallet, PENDING_POLICY, processed, settle, T0, usd } from '../support/builders';

/** Reference-dependent operation pointing at `ref`, same round/wallet unless overridden. */
const against = (ref: WagerTransaction, kind: Kind, amount = ref.money.amount) =>
  makeTx({
    kind,
    money: brl(amount),
    referenceExternalTransactionId: ref.externalTransactionId,
    roundId: ref.roundId,
  });

describe('BET', () => {
  it('debits the wallet and produces one DEBIT entry', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = makeTx({ money: brl('25.00') });

    const outcome = settle({ transaction: bet, wallet });

    expect(outcome.status).toBe(Status.Processed);
    const entry = (outcome as { ledgerEntry: WalletLedgerEntry }).ledgerEntry;
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.amount).toBe('75.00');
  });

  it('is rejected with INSUFFICIENT_FUNDS without touching the wallet', () => {
    const wallet = makeWallet({ balance: '10.00' });
    const bet = makeTx({ money: brl('10.01') });

    expect(settle({ transaction: bet, wallet })).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(bet.balanceAfter?.amount).toBe('10.00');
  });

  it('challenge §8 (domain level): two BETs of 80.00 on 100.00 → one PROCESSED, one REJECTED, 20.00 left', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const outcomes = [makeTx({ money: brl('80.00') }), makeTx({ money: brl('80.00') })].map((bet) =>
      settle({ transaction: bet, wallet }),
    );

    expect(outcomes.map((o) => o.status)).toEqual([Status.Processed, Status.Rejected]);
    expect(outcomes.filter((o) => 'ledgerEntry' in o && o.ledgerEntry)).toHaveLength(1);
    expect(wallet.balance.amount).toBe('20.00');
  });
});

describe('WIN', () => {
  it('credits the wallet, with or without referencing its BET', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = processed(wallet, { money: brl('10.00') });

    const plain = makeTx({ kind: Kind.Win, money: brl('5.00') });
    const linked = against(bet, Kind.Win, '30.00');
    settle({ transaction: plain, wallet });
    settle({ transaction: linked, wallet, reference: bet });

    expect(wallet.balance.amount).toBe('125.00');
    expect(plain.referenceTransactionId).toBeUndefined();
    expect(linked.referenceTransactionId).toBe(bet.id);
  });

  it('with zero amount is PROCESSED without ledger entry and without bumping the version', () => {
    const wallet = makeWallet();
    const win = makeTx({ kind: Kind.Win, money: brl('0.00') });

    expect(settle({ transaction: win, wallet })).toEqual({ status: Status.Processed });
    expect(wallet.version).toBe(1);
    expect(win.balanceAfter?.amount).toBe('100.00');
  });

  it('referencing a BET of another round is rejected', () => {
    const wallet = makeWallet();
    const bet = processed(wallet, { roundId: 'round-1' });
    const win = makeTx({
      kind: Kind.Win,
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'round-2',
    });

    expect(settle({ transaction: win, wallet, reference: bet })).toMatchObject({
      failureCode: FailureCode.ReferenceMismatch,
    });
  });
});

describe('LOSS', () => {
  it.each(['0.00', '25.00'])('with amount %s moves nothing: no entry, same balance and version', (amount) => {
    const wallet = makeWallet({ balance: '100.00' });
    const loss = makeTx({ kind: Kind.Loss, money: brl(amount) });

    expect(settle({ transaction: loss, wallet })).toEqual({ status: Status.Processed });
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(loss.status).toBe(Status.Processed);
  });
});

describe('REFUND', () => {
  it('credits back a PROCESSED BET', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = processed(wallet, { money: brl('40.00') });
    const refund = against(bet, Kind.Refund);

    const outcome = settle({ transaction: refund, wallet, reference: bet });

    expect(outcome.status).toBe(Status.Processed);
    expect((outcome as { ledgerEntry: WalletLedgerEntry }).ledgerEntry.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  it.each([
    ['a WIN', Kind.Win],
    ['a LOSS', Kind.Loss],
  ])('cannot target %s', (_label, kind) => {
    const wallet = makeWallet();
    const target = processed(wallet, { kind, money: brl('10.00') });
    expect(settle({ transaction: against(target, Kind.Refund), wallet, reference: target })).toMatchObject({
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  it('must match the BET amount (no partial refunds)', () => {
    const wallet = makeWallet();
    const bet = processed(wallet, { money: brl('40.00') });
    expect(settle({ transaction: against(bet, Kind.Refund, '39.99'), wallet, reference: bet })).toMatchObject(
      {
        failureCode: FailureCode.ReferenceAmountMismatch,
      },
    );
  });

  it('with zero amount is accepted as payload and rejected by rule 5 (persisted, auditable)', () => {
    const wallet = makeWallet();
    const bet = processed(wallet, { money: brl('40.00') });
    const zeroRefund = against(bet, Kind.Refund, '0.00');
    expect(settle({ transaction: zeroRefund, wallet, reference: bet })).toMatchObject({
      failureCode: FailureCode.ReferenceAmountMismatch,
    });
    expect(zeroRefund.status).toBe(Status.Rejected);
  });

  it('cannot target a BET that was REJECTED', () => {
    const wallet = makeWallet({ balance: '1.00' });
    const bet = makeTx({ money: brl('50.00') });
    settle({ transaction: bet, wallet });
    expect(bet.status).toBe(Status.Rejected);

    expect(settle({ transaction: against(bet, Kind.Refund), wallet, reference: bet })).toMatchObject({
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('ROLLBACK', () => {
  it('of a BET credits it back', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = processed(wallet, { money: brl('30.00') });
    settle({ transaction: against(bet, Kind.Rollback), wallet, reference: bet });
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('of a WIN debits it back', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const win = processed(wallet, { kind: Kind.Win, money: brl('50.00') });
    settle({ transaction: against(win, Kind.Rollback), wallet, reference: win });
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('of a REFUND debits it back', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = processed(wallet, { money: brl('30.00') });
    const refund = processed(wallet, {
      kind: Kind.Refund,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
      reference: bet,
    });
    expect(wallet.balance.amount).toBe('100.00');

    settle({ transaction: against(refund, Kind.Rollback), wallet, reference: refund });
    expect(wallet.balance.amount).toBe('70.00');
  });

  it('of a WIN already spent is rejected with REVERSAL_INSUFFICIENT_FUNDS (not INSUFFICIENT_FUNDS)', () => {
    const wallet = makeWallet({ balance: '0.00' });
    const win = processed(wallet, { kind: Kind.Win, money: brl('50.00') });
    processed(wallet, { money: brl('45.00') }); // the player bets most of the prize

    const rollback = against(win, Kind.Rollback);
    expect(settle({ transaction: rollback, wallet, reference: win })).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(wallet.balance.amount).toBe('5.00');
    expect(rollback.status).toBe(Status.Rejected);
  });

  it.each([
    ['a LOSS', Kind.Loss],
    ['a ROLLBACK', Kind.Rollback],
  ])('cannot target %s', (_label, kind) => {
    const wallet = makeWallet();
    const bet = processed(wallet, { money: brl('10.00') });
    const target =
      kind === Kind.Rollback
        ? processed(wallet, {
            kind: Kind.Rollback,
            money: brl('10.00'),
            referenceExternalTransactionId: bet.externalTransactionId,
            reference: bet,
          })
        : processed(wallet, { kind, money: brl('10.00') });

    expect(settle({ transaction: against(target, Kind.Rollback), wallet, reference: target })).toMatchObject({
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe('reversal applied only once (decision A1)', () => {
  it.each([
    ['REFUND after REFUND', Kind.Refund],
    ['ROLLBACK after REFUND (no double credit)', Kind.Rollback],
  ])('%s is rejected with REFERENCE_ALREADY_REVERSED', (_label, secondKind) => {
    const wallet = makeWallet({ balance: '100.00' });
    const bet = processed(wallet, { money: brl('40.00') });
    settle({ transaction: against(bet, Kind.Refund), wallet, reference: bet });

    const second = against(bet, secondKind);
    expect(
      settle({ transaction: second, wallet, reference: bet, referenceAlreadyReversed: true }),
    ).toMatchObject({
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.amount).toBe('100.00');
  });
});

describe('reference context', () => {
  it.each([
    ['another player and wallet', { id: 'wallet-2', playerId: 'player-2', currency: 'BRL' }],
    [
      'another currency (same player, USD wallet)',
      { id: 'wallet-usd', playerId: 'player-1', currency: 'USD' },
    ],
  ])('rejects a reference from %s', (_label, other) => {
    const wallet = makeWallet();
    const otherWallet = makeWallet(other);
    const foreignBet = processed(otherWallet, {
      walletId: other.id,
      playerId: other.playerId,
      money: Money.from({ amount: '10.00', currency: other.currency }),
    });

    const refund = makeTx({
      kind: Kind.Refund,
      money: brl('10.00'),
      referenceExternalTransactionId: foreignBet.externalTransactionId,
    });
    expect(settle({ transaction: refund, wallet, reference: foreignBet })).toMatchObject({
      failureCode: FailureCode.ReferenceMismatch,
    });
  });
});

describe('references arriving out of order (§7.1)', () => {
  it('ROLLBACK before its BET waits, then settles once the BET is processed', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const betProps = { externalTransactionId: 'bet-late', money: brl('20.00') };
    const rollback = makeTx({
      kind: Kind.Rollback,
      money: brl('20.00'),
      referenceExternalTransactionId: 'bet-late',
    });

    expect(settle({ transaction: rollback, wallet, at: at(0) })).toEqual({ status: Status.PendingReference });
    expect(rollback.referenceAttempts).toBe(1);
    expect(rollback.nextReferenceCheckAt).toEqual(at(1));
    expect(wallet.version).toBe(1);

    const bet = processed(wallet, betProps);
    expect(wallet.balance.amount).toBe('80.00');

    expect(settle({ transaction: rollback, wallet, reference: bet, at: at(2) }).status).toBe(
      Status.Processed,
    );
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('keeps waiting while the reference is itself pending', () => {
    const wallet = makeWallet();
    const win = makeTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-x' });
    settle({ transaction: win, wallet });
    const rollback = makeTx({
      kind: Kind.Rollback,
      money: win.money,
      referenceExternalTransactionId: win.externalTransactionId,
    });

    expect(settle({ transaction: rollback, wallet, reference: win })).toEqual({
      status: Status.PendingReference,
    });
  });

  it('gives up with REFERENCE_NOT_FOUND after maxAttempts', () => {
    const wallet = makeWallet();
    const refund = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'never-arrives' });

    const statuses = [0, 1, 2, 3].map((n) => settle({ transaction: refund, wallet, at: at(n * 10) }).status);

    expect(statuses).toEqual([
      Status.PendingReference,
      Status.PendingReference,
      Status.PendingReference,
      Status.Rejected,
    ]);
    expect(refund.referenceAttempts).toBe(PENDING_POLICY.maxAttempts);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});

describe('wallet checks', () => {
  it('rejects a wallet of another player without exposing its balance', () => {
    const wallet = makeWallet({ playerId: 'someone-else' });
    const bet = makeTx();
    expect(settle({ transaction: bet, wallet })).toMatchObject({
      failureCode: FailureCode.WalletPlayerMismatch,
    });
    expect(bet.balanceAfter).toBeUndefined();
  });

  it('rejects an operation in another currency', () => {
    const wallet = makeWallet();
    const bet = makeTx({ money: usd('10.00') });
    expect(settle({ transaction: bet, wallet })).toMatchObject({ failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.version).toBe(1);
  });

  it('refuses to settle twice or against the wrong wallet (programming errors)', () => {
    const wallet = makeWallet();
    const bet = processed(wallet);
    expect(() => settle({ transaction: bet, wallet })).toThrow(InvariantViolationError);
    expect(() => settle({ transaction: makeTx(), wallet: makeWallet({ id: 'other' }) })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('invariant: balance == balance rebuilt from the ledger', () => {
  it('holds across a full mixed sequence', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      at: T0,
      opening: { transactionId: 'opening', entryId: 'opening-entry' },
    });
    const entries: WalletLedgerEntry[] = [openingEntry as WalletLedgerEntry];
    const run = (tx: WagerTransaction, reference?: WagerTransaction, reversed = false) => {
      const outcome = settle({ transaction: tx, wallet, reference, referenceAlreadyReversed: reversed });
      if ('ledgerEntry' in outcome && outcome.ledgerEntry) entries.push(outcome.ledgerEntry);
      return tx;
    };

    const bet1 = run(makeTx({ money: brl('30.00') }));
    run(against(bet1, Kind.Win, '75.50'), bet1);
    const bet2 = run(makeTx({ money: brl('20.00') }));
    run(against(bet2, Kind.Refund), bet2);
    run(against(bet2, Kind.Rollback), bet2, true); // rejected: already reversed
    run(makeTx({ kind: Kind.Loss, money: brl('5.00') }));
    run(makeTx({ money: brl('1000.00') })); // rejected: insufficient funds
    const win = run(makeTx({ kind: Kind.Win, money: brl('10.00') }));
    run(against(win, Kind.Rollback), win);

    const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe('145.50');
    expect(wallet.version).toBe(1 + entries.length - 1); // opening does not bump; every other entry does
  });
});
