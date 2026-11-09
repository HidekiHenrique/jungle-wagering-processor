/**
 * Lifecycle:
 *
 *   PENDING ──────────────┬──> PROCESSED   (terminal)
 *      │                  ├──> REJECTED    (terminal)
 *      v                  │
 *   PENDING_REFERENCE ────┼──> FAILED      (terminal, only after being persisted)
 *      ↺ (retry)          │
 *
 * PENDING exists only inside the SQL transaction that settles the operation; what gets
 * committed is always PROCESSED, REJECTED or PENDING_REFERENCE.
 */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];
