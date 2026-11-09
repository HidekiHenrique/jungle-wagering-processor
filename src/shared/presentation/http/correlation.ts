import { currentLogContext } from '../../infrastructure/logger/log-context';

/** Correlation id of the current request (set by CorrelationIdMiddleware). */
export function currentCorrelationId(): string {
  return currentLogContext().correlationId ?? Bun.randomUUIDv7();
}
