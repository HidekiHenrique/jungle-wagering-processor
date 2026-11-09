import { describe, expect, it } from 'bun:test';
import { BackoffPolicy } from '../../../src/shared/domain/backoff-policy';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { T0 } from '../support/builders';

describe('BackoffPolicy', () => {
  const policy = BackoffPolicy.of({ baseDelayMs: 1_000, maxDelayMs: 5_000, maxAttempts: 4 });

  it('doubles the delay per attempt up to the cap', () => {
    expect([1, 2, 3, 4, 5, 50].map((n) => policy.delayAfter(n))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
  });

  it('computes the next attempt time from now', () => {
    expect(policy.nextAttemptAt(T0, 2).getTime() - T0.getTime()).toBe(2_000);
  });

  it('reports exhaustion at maxAttempts', () => {
    expect(policy.isExhausted(3)).toBe(false);
    expect(policy.isExhausted(4)).toBe(true);
  });

  it('rejects invalid configuration and attempt numbers', () => {
    expect(() => BackoffPolicy.of({ baseDelayMs: 0, maxDelayMs: 1, maxAttempts: 1 })).toThrow(
      InvariantViolationError,
    );
    expect(() => BackoffPolicy.of({ baseDelayMs: 10, maxDelayMs: 5, maxAttempts: 1 })).toThrow(
      InvariantViolationError,
    );
    expect(() => policy.delayAfter(0)).toThrow(InvariantViolationError);
  });
});
