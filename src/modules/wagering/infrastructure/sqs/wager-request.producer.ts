import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface WagerRequestData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * Producer side of wager-transactions.fifo (what a provider integration would run).
 * MessageGroupId = walletId keeps one wallet's operations in order; MessageDeduplicationId =
 * messageId lets SQS drop resends within its 5-minute window (an optimization only: the inbox
 * and the database are the real guarantee).
 */
export async function sendWagerRequest(
  sqs: SQSClient,
  queueUrl: string,
  data: WagerRequestData,
  messageId: string = Bun.randomUUIDv7(),
  options: { deduplicationId?: string } = {},
): Promise<string> {
  const body = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: data.walletId,
      MessageDeduplicationId: options.deduplicationId ?? messageId,
    }),
  );
  return messageId;
}
