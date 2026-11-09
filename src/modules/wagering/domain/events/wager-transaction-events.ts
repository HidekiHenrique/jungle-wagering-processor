import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import { type EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import type { WagerTransaction } from '../wager-transaction';
import type { WagerTransactionKind } from '../wager-transaction-kind';
import { WagerTransactionStatus } from '../wager-transaction-status';

/** Fields shared by every wager transaction event. */
interface WagerTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function refOf(tx: WagerTransaction): WagerTransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus, event: string): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(
      `${event} requires a ${expected} transaction, ${tx.id} is ${tx.status}`,
    );
  }
}

export interface WagerTransactionProcessedData extends WagerTransactionRef {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS and zero-amount WIN (which move no money). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...refOf(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: (tx.balanceAfter as NonNullable<typeof tx.balanceAfter>).toJSON(),
        processedAt: (tx.processedAt as Date).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionRef {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...refOf(tx),
        failureCode: tx.failureCode as FailureCode,
        rejectedAt: (tx.processedAt as Date).toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...refOf(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId as string,
        attempts: tx.referenceAttempts,
        nextCheckAt: (tx.nextReferenceCheckAt as Date).toISOString(),
      },
    });
  }
}
