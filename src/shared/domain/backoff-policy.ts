import { InvariantViolationError } from './domain-error';

/**
 * Exponential backoff shared by every retry loop in the domain
 * (pending references, outbox publication).
 *
 * delay(attempt) = min(baseDelayMs * 2^(attempt - 1), maxDelayMs)
 */
export class BackoffPolicy {
  private constructor(
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
    readonly maxAttempts: number,
  ) {}

  static of(props: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number }): BackoffPolicy {
    const { baseDelayMs, maxDelayMs, maxAttempts } = props;
    const positiveInt = (n: number) => Number.isInteger(n) && n > 0;
    if (!positiveInt(baseDelayMs) || !positiveInt(maxDelayMs) || !positiveInt(maxAttempts)) {
      throw new InvariantViolationError('BackoffPolicy values must be positive integers');
    }
    if (maxDelayMs < baseDelayMs) throw new InvariantViolationError('maxDelayMs must be >= baseDelayMs');
    return new BackoffPolicy(baseDelayMs, maxDelayMs, maxAttempts);
  }

  /** Delay before the next try, given how many attempts were already made (>= 1). */
  delayAfter(attempts: number): number {
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new InvariantViolationError('attempts must be an integer >= 1');
    }
    // Cap the exponent: 2^31 already exceeds any sane maxDelayMs, and avoids Infinity.
    const exponential = this.baseDelayMs * 2 ** Math.min(attempts - 1, 31);
    return Math.min(exponential, this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempts: number): Date {
    return new Date(now.getTime() + this.delayAfter(attempts));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
