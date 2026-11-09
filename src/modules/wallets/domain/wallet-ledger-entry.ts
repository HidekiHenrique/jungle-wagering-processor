import { DomainError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One immutable movement of a wallet balance.
 *
 * Immutability is structural: every field is `readonly`, the instance is frozen and there are
 * no transition methods.
 * `create` validates the arithmetic (`balanceBefore ± money === balanceAfter`), so an
 * unbalanced entry cannot exist in memory; the database repeats the check with a CHECK constraint.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    // Runtime immutability too: `readonly` alone is erased by the compiler.
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter } = entry;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('money and balances must share the same currency');
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError('money must be positive');
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances cannot be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${balanceBefore} ${entry.direction === LedgerDirection.Credit ? '+' : '-'} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Rebuilds a persisted entry. Does not re-validate: the row was validated when written. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
