import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/modules/wallets/domain/ledger-direction';
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/modules/wallets/domain/wallet-ledger-entry';
import { brl, T0, usd } from '../support/builders';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'e',
  walletId: 'w',
  transactionId: 't',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: T0,
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  it('creates balanced debit and credit entries', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(credit.signedAmount().amount).toBe('25.00');
    expect(WalletLedgerEntry.create(props()).signedAmount().amount).toBe('-25.00');
  });

  it.each([
    ['unbalanced arithmetic', { balanceAfter: brl('76.00') }, '100.00 BRL - 25.00 BRL != 76.00 BRL'],
    ['credit computed as debit', { direction: LedgerDirection.Credit }, '!='],
    ['zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }, 'money must be positive'],
    [
      'negative resulting balance',
      { balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() },
      'cannot be negative',
    ],
    ['mixed currencies', { money: usd('25.00') }, 'same currency'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(message);
  });

  it('is structurally immutable: frozen instance, no transition methods', () => {
    const entry = WalletLedgerEntry.create(props());
    const mutable = entry as unknown as { balanceAfter: unknown };
    expect(() => {
      mutable.balanceAfter = brl('1000.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(Object.getOwnPropertyNames(WalletLedgerEntry.prototype).sort()).toEqual(
      ['constructor', 'isBalanced', 'signedAmount'].sort(),
    );
  });
});
