import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import { ConcurrentModificationError } from '../../application/application-error';
import type { TransientErrorClassifier } from '../../application/transient-error-classifier.port';

/**
 * PostgreSQL SQLSTATEs that mean "try again later", not "your request is wrong".
 * See https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** True for infrastructure failures that a retry may fix. Used by the HTTP layer (503) and consumers (no ack). */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof ConcurrentModificationError) return true;
  if (error instanceof DeadlockException || error instanceof LockWaitTimeoutException) return true;
  if (error instanceof ConnectionException) return true;
  if (typeof error !== 'object' || error === null) return false;

  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code)))
    return true;
  // pg pool: "timeout exceeded when trying to connect"; pg: "Connection terminated unexpectedly"
  return (
    typeof message === 'string' &&
    /timeout exceeded when trying to connect|connection terminated/i.test(message)
  );
}

export const postgresTransientErrorClassifier: TransientErrorClassifier = {
  isTransient: isTransientInfrastructureError,
};
