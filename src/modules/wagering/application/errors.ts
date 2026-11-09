import { ApplicationError } from '../../../shared/application/application-error';

/** Same Idempotency-Key, different payload: a client bug, never a replay (409). */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly idempotencyKey: string,
  ) {
    super(`Idempotency key ${idempotencyKey} of ${providerId} was already used with a different payload`);
  }
}

/** The provider already sent this externalTransactionId under another Idempotency-Key (409). */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(
      `Transaction ${externalTransactionId} of ${providerId} already exists under another idempotency key`,
    );
  }
}
