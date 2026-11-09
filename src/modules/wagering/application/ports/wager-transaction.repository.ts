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

  /**
   * Makes PENDING_REFERENCE transactions of the same wallet that wait for `settled` due now.
   * Called under the wallet lock, so it never races with a worker settling them.
   */
  wakeDependents(settled: WagerTransaction, now: Date): Promise<number>;

  /** Candidates for a retry: PENDING_REFERENCE and due, oldest schedule first. No locks taken. */
  findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;

  /**
   * Locks one PENDING_REFERENCE transaction for this worker (`FOR UPDATE SKIP LOCKED`), only if
   * it is still pending and due. undefined: another worker has it, or it was already settled.
   */
  claimPendingReference(id: string, now: Date): Promise<WagerTransaction | undefined>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WagerTransactionRepository');
