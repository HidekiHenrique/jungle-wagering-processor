import type { WagerTransaction } from '../../domain/wager-transaction';

/** Full view of a transaction for the GET endpoints. */
export const toWagerTransactionResponse = (t: WagerTransaction) => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  ...(t.referenceExternalTransactionId
    ? { referenceExternalTransactionId: t.referenceExternalTransactionId }
    : {}),
  ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
  status: t.status,
  ...(t.failureCode ? { failureCode: t.failureCode } : {}),
  ...(t.balanceAfter ? { balance: t.balanceAfter.toJSON() } : {}),
  createdAt: t.createdAt.toISOString(),
  ...(t.processedAt ? { processedAt: t.processedAt.toISOString() } : {}),
});
