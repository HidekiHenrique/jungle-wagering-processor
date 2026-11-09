import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/modules/wallets/domain/ledger-direction';
import {
  InsufficientFundsError,
  InvalidWalletError,
  Wallet,
} from '../../../src/modules/wallets/domain/wallet';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { CurrencyMismatchError, Money } from '../../../src/shared/domain/money';
import { at, brl, makeWallet, T0, usd } from '../support/builders';

const move = (amount: string, n = 1) => ({
  entryId: `e-${n}`,
  transactionId: `t-${n}`,
  money: brl(amount),
  at: at(n),
});

describe('Wallet.open', () => {
  it('opens with the initial balance, version 1 and an OPENING credit entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { transactionId: 'opening-tx', entryId: 'opening-entry' },
    });
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toMatchObject({ direction: LedgerDirection.Credit, transactionId: 'opening-tx' });
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  it('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.zero('BRL'),
      at: T0,
    });
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('requires the OPENING ids when the initial balance is positive', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at: T0 })).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects a negative initial balance and missing identity', () => {
    const negative = brl('1.00').negate();
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: negative, at: T0 })).toThrow(
      InvalidWalletError,
    );
    expect(() => Wallet.open({ id: '', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0 })).toThrow(
      InvalidWalletError,
    );
  });
});

describe('Wallet movements', () => {
  it('debit and credit return a balanced entry and keep balance and entry in sync', () => {
    const wallet = makeWallet({ balance: '100.00' });
    const debit = wallet.debit(move('80.00', 1));
    const credit = wallet.credit(move('5.50', 2));

    expect(debit).toMatchObject({
      direction: LedgerDirection.Debit,
      walletId: wallet.id,
      transactionId: 't-1',
    });
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(credit.balanceBefore.amount).toBe('20.00');
    expect(credit.balanceAfter.amount).toBe('25.50');
    expect(wallet.balance.equals(credit.balanceAfter)).toBe(true);
    expect(wallet.updatedAt).toEqual(at(2));
  });

  it('increments version once per balance change', () => {
    const wallet = makeWallet({ version: 1 });
    wallet.debit(move('1.00', 1));
    wallet.credit(move('1.00', 2));
    expect(wallet.version).toBe(3);
  });

  it('allows debiting the exact balance down to zero', () => {
    const wallet = makeWallet({ balance: '80.00' });
    wallet.debit(move('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('never goes negative: an oversized debit throws and leaves the wallet untouched', () => {
    const wallet = makeWallet({ balance: '100.00', version: 7 });
    expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(T0);
  });

  it('rejects movements in another currency', () => {
    const wallet = makeWallet();
    const usdMove = { ...move('1.00'), money: usd('1.00') };
    expect(() => wallet.debit(usdMove)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usdMove)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rejects zero-amount movements (they would produce an empty ledger entry)', () => {
    const wallet = makeWallet();
    expect(() => wallet.credit(move('0.00'))).toThrow('money must be positive');
    expect(wallet.version).toBe(1);
  });

  it('rehydrates without changing state', () => {
    const wallet = makeWallet({ balance: '42.00', version: 9 });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(9);
  });
});
