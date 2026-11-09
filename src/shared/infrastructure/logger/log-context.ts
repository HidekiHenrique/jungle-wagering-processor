import { AsyncLocalStorage } from 'node:async_hooks';

/** Identifiers attached to every log line produced while handling one request or message. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `fn` with its own log context. Everything awaited inside `fn` sees the same context,
 * without passing it as a parameter through every call (similar to a per-request global in PHP,
 * but safe with concurrent requests in the same process).
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Adds identifiers discovered mid-flow (e.g. walletId after parsing the payload). */
export function enrichLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? {};
}
