/**
 * Sends one WagerTransactionRequested message to the input queue.
 *
 *   bun scripts/send-wager-message.ts <walletId> <playerId> [kind=BET] [amount=25.00] [externalTransactionId]
 */
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/modules/messaging/infrastructure/sqs/sqs-client.factory';
import { sendWagerRequest } from '../src/modules/wagering/infrastructure/sqs/wager-request.producer';
import { loadConfig } from '../src/shared/infrastructure/config/app-config';

const [walletId, playerId, kind = 'BET', amount = '25.00', externalId] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('Usage: bun scripts/send-wager-message.ts <walletId> <playerId> [kind] [amount] [externalTransactionId]');
  process.exit(1);
}

const config = loadConfig(process.env);
const sqs = createSqsClient(config);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.wagerQueue }));
const externalTransactionId = externalId ?? `cli-${Date.now()}`;
const messageId = await sendWagerRequest(sqs, QueueUrl as string, {
  providerId: 'provider-a',
  externalTransactionId,
  idempotencyKey: `provider-a:${externalTransactionId}`,
  playerId,
  walletId,
  roundId: 'round-cli',
  gameId: 'fortune-chimp',
  kind,
  money: { amount, currency: 'BRL' },
});
console.log(JSON.stringify({ messageId, externalTransactionId }));
sqs.destroy();
