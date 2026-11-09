import { Money } from '../../../../shared/domain/money';
import type { FailureCode } from '../../domain/failure-code';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import type { WagerTransactionRecord } from './wager-transaction.record';

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: r.currency });
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount),
      referenceExternalTransactionId: orUndefined(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(r.referenceTransactionId),
      failureCode: orUndefined(r.failureCode) as FailureCode | undefined,
      processedAt: orUndefined(r.processedAt),
      balanceAfter: r.balanceAfter ? money(r.balanceAfter) : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceCheckAt: orUndefined(r.nextReferenceCheckAt),
    });
  },

  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      balanceAfter: t.balanceAfter?.amount ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceCheckAt: t.nextReferenceCheckAt ?? null,
      createdAt: t.createdAt,
      processedAt: t.processedAt ?? null,
    };
  },
};
