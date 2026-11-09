import type { WagerTransaction } from '../../domain/wager-transaction';

export interface WagerTransactionRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING. A concurrent insert of the same key waits until the
   * other transaction ends, so duplicates queue on the unique index, not on the wallet lock.
   * @returns false when (providerId, idempotencyKey) or (providerId, externalTransactionId) exists.
   */
  tryInsert(transaction: WagerTransaction): Promise<boolean>;

  /** Persists status, outcome and retry fields of an existing row. */
  updateOutcome(transaction: WagerTransaction): Promise<void>;

  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  /** Whether a PROCESSED REFUND or ROLLBACK already targets `referenceId`. */
  hasProcessedReversal(referenceId: string): Promise<boolean>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WagerTransactionRepository');
