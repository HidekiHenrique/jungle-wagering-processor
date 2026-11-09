/**
 * Runs `work` inside one database transaction: everything it persists commits together or not
 * at all. Repositories called inside `work` automatically join the transaction.
 *
 * `work` must not call the network (SQS, HTTP): it would hold row locks while waiting.
 */
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TransactionRunner');
