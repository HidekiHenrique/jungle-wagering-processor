/**
 * Stable, machine-readable reasons a transaction ended REJECTED or FAILED.
 *
 * Contract with providers: values are never renamed or reused. A rejection is final for that
 * idempotency key; resending the same payload returns the same rejection (replay). To try again
 * the provider must fix the cause and send a NEW transaction.
 */
export enum FailureCode {
  // --- balance
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK that would drive the balance negative (e.g. reverting a WIN already spent). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // --- wallet
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** The wallet exists but belongs to another player. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** No wallet with this id. Returned to the caller but NOT persisted (nothing to audit). */
  WalletNotFound = 'WALLET_NOT_FOUND',

  // --- references
  /** The referenced transaction never arrived before the pending-reference retries ran out. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** The referenced transaction exists but ended REJECTED or FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to another player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind not allowed for this operation (e.g. REFUND of a WIN, ROLLBACK of a LOSS). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversal is out of scope). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** The reference was already reverted, by a REFUND or a ROLLBACK. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  // --- infrastructure (FAILED)
  /** Permanent processing error on an already persisted transaction; kept for audit. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
