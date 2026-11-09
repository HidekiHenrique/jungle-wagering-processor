import { DomainError } from './domain-error';

/** Wire format: `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Non-negative decimal with at most 2 fraction digits and no leading zeros.
 * Rejects by construction: "", " 1", "-1", "+1", "1e3", "NaN", "Infinity", "0x10", "1.", ".5", "1.234", "01".
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;
const FACTOR = 100n;

/**
 * Immutable monetary value.
 *
 * Stored as an integer number of minor units (cents) in a `bigint`: exact arithmetic, no
 * floating point anywhere. Scale is fixed at 2 for every currency (challenge §6.1), so there is
 * no rounding: inputs with more than 2 decimals are rejected, never rounded.
 *
 * The integer part is capped at 18 digits so every value fits the `numeric(20,2)` columns.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses an input contract. Rejects negatives: amounts on the wire are always >= 0. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    if (typeof amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" must be a non-negative decimal with at most ${SCALE} decimal places`,
      );
    }
    return new Money(Money.parseMinorUnits(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  get amount(): string {
    const sign = this.minorUnits < 0n ? '-' : '';
    const abs = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${sign}${abs / FACTOR}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Value equality. Different currencies are simply not equal (no error). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static parseMinorUnits(amount: string): bigint {
    const [integer = '0', fraction = ''] = amount.split('.');
    return BigInt(integer) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" must be a 3-letter ISO-4217 code`);
    }
    return currency;
  }
}
