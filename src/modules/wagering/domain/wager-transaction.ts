import type { BackoffPolicy } from '../../../shared/domain/backoff-policy';
import { DomainError, InvariantViolationError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import { invertDirection, LedgerDirection } from '../../wallets/domain/ledger-direction';
import type { FailureCode } from './failure-code';
import { PROVIDER_KINDS, REVERSAL_KINDS, WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

/** Reserved provider for internal transactions (OPENING). Providers can never use it. */
export const INTERNAL_PROVIDER_ID = '__internal__';

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Payload that can never become a valid transaction: maps to 400 (invalid payload). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

/** Programming error: a transition was attempted from a state that forbids it. */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, from: WagerTransactionStatus, action: string) {
    super(`Transaction ${transactionId} is ${from}: cannot ${action}`);
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Wallet balance observed when the outcome was decided; returned on replay. */
  balanceAfter?: Money | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

/**
 * A provider operation (or the internal OPENING credit) and its lifecycle.
 *
 * Holds identity and outcome only; it never touches balances. Settling it against a wallet is
 * the job of `settleWager`, which calls the explicit transitions below.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** Provider-side id of the referenced transaction, not the internal id. */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** A provider operation, born PENDING. Validates everything that does not depend on other data. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /** The internal credit of a wallet's initial balance. The only way to build an OPENING. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) throw new InvariantViolationError('OPENING requires a positive amount');
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: 'internal',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /** Rebuilds a persisted transaction. Does not re-validate rules or transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions

  markProcessed(props: { at: Date; balanceAfter: Money; referenceTransactionId?: string | undefined }): void {
    this.assertOpen('mark as processed');
    if (this.requiresReference() && !props.referenceTransactionId) {
      throw new InvariantViolationError(`${this.kind} ${this.id} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
    this._nextReferenceCheckAt = undefined;
  }

  /** Parks the transaction until its reference shows up; each call counts one attempt. */
  markPendingReference(now: Date, policy: BackoffPolicy): void {
    this.assertOpen('wait for its reference');
    if (!this.referenceExternalTransactionId) {
      throw new InvariantViolationError(`${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = policy.nextAttemptAt(now, this._referenceAttempts);
  }

  /**
   * @param balanceAfter balance observed at decision time, returned on replay. Omit it when the
   *   wallet does not belong to the caller, so a replay never leaks someone else's balance.
   */
  reject(code: FailureCode, props: { at: Date; balanceAfter?: Money | undefined }): void {
    this.assertOpen('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** LOSS never moves money; neither does a zero-amount WIN (a common "no prize" signal). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && this.money.isPositive();
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  hasExhaustedReferenceAttempts(policy: BackoffPolicy): boolean {
    return policy.isExhausted(this._referenceAttempts);
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * ROLLBACK is the inverse of its reference: BET (debit) → credit; WIN or REFUND (credit) → debit.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference || reference.kind === WagerTransactionKind.Rollback) {
          throw new InvariantViolationError(`ROLLBACK ${this.id} needs a non-ROLLBACK reference`);
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS produces no ledger entry');
    }
  }

  private assertOpen(action: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.id, this._status, action);
  }

  private static validate(props: CreateWagerTransactionProps): void {
    const fail = (reason: string): never => {
      throw new InvalidWagerTransactionError(reason);
    };
    const requireId = (name: string, value: string | undefined, max = MAX_ID_LENGTH) => {
      if (typeof value !== 'string' || value.trim() === '') fail(`${name} is required`);
      else if (value.length > max) fail(`${name} must have at most ${max} characters`);
    };

    if (!PROVIDER_KINDS.includes(props.kind)) {
      fail(
        props.kind === WagerTransactionKind.Opening ? 'OPENING is internal' : `unknown kind "${props.kind}"`,
      );
    }
    requireId('id', props.id);
    requireId('providerId', props.providerId);
    if (props.providerId === INTERNAL_PROVIDER_ID) fail('providerId is reserved');
    requireId('externalTransactionId', props.externalTransactionId);
    requireId('idempotencyKey', props.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    requireId('payloadHash', props.payloadHash);
    requireId('walletId', props.walletId);
    requireId('playerId', props.playerId);
    requireId('roundId', props.roundId);
    requireId('gameId', props.gameId);

    const ref = props.referenceExternalTransactionId;
    if (REVERSAL_KINDS.includes(props.kind) && ref === undefined) {
      fail(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (ref !== undefined) {
      if (props.kind === WagerTransactionKind.Bet) fail('BET does not accept a reference');
      requireId('referenceExternalTransactionId', ref);
      if (ref === props.externalTransactionId) fail('a transaction cannot reference itself');
    }

    // Zero-amount reversals are not rejected here: rule 5 (amount equal to the reference) decides,
    // so they end REJECTED/REFERENCE_AMOUNT_MISMATCH and stay auditable.
    if (props.kind === WagerTransactionKind.Bet && !props.money.isPositive()) {
      fail('BET amount must be greater than zero');
    }
  }
}
