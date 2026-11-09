import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../src/shared/domain/money';
import { brl, usd } from '../support/builders';

describe('Money.from', () => {
  it.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts "%s" and serializes with scale 2 as "%s"', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  it.each([
    ['empty string', ''],
    ['whitespace', ' 1.00'],
    ['negative', '-1.00'],
    ['explicit plus sign', '+1.00'],
    ['scientific notation', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['hexadecimal', '0x10'],
    ['more than 2 decimals (never rounded)', '1.005'],
    ['trailing dot', '1.'],
    ['leading dot', '.50'],
    ['leading zeros', '007.00'],
    ['comma decimal separator', '1,00'],
    ['more than 18 integer digits', '1000000000000000000.00'],
  ])('rejects %s', (_label, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects a JSON number instead of a string (no float ever reaches the domain)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      'amount must be a decimal string',
    );
  });

  it.each(['brl', 'BR', 'BRLL', '', '123'])('rejects currency "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('is exact where floating point is not (0.1 + 0.2)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  it('adds, subtracts and negates', () => {
    expect(brl('100.00').add(brl('0.01')).amount).toBe('100.01');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('20.00').subtract(brl('80.00')).amount).toBe('-60.00');
    expect(brl('25.50').negate().amount).toBe('-25.50');
    expect(brl('0.05').negate().amount).toBe('-0.05');
  });

  it('is immutable: operations return new instances', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(original.amount).toBe('10.00');
    expect(sum).not.toBe(original);
  });

  it('compares values', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('25.00').equals(brl('25'))).toBe(true);
  });

  it('treats different currencies as different values in equals()', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('throws a domain error on %s across currencies', (_op, fn) => {
    expect(() => fn(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Money.fromSigned', () => {
  it('parses internal signed amounts', () => {
    expect(Money.fromSigned('-5.25', 'BRL').amount).toBe('-5.25');
    expect(Money.fromSigned('5.25', 'BRL').amount).toBe('5.25');
    expect(() => Money.fromSigned('--1', 'BRL')).toThrow(InvalidMoneyError);
  });
});

describe('Money serialization', () => {
  it('serializes to the wire contract', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  it('round-trips through JSON without loss', () => {
    const value = brl('123456789012345678.91');
    expect(Money.from(value.toJSON()).equals(value)).toBe(true);
  });
});
