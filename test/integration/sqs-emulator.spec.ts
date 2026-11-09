import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-client.factory';
import { loadConfig } from '../../src/shared/infrastructure/config/app-config';

/**
 * The messaging design relies on these SQS FIFO semantics. This suite proves the emulator
 * implements them, so later failures point at our code, not at the emulator.
 * Uses throwaway queues; never touches the application queues.
 */
describe('SQS emulator fidelity', () => {
  const sqs: SQSClient = createSqsClient(loadConfig(process.env));
  const suffix = Bun.randomUUIDv7().slice(-8);
  let queueUrl: string;
  let dlqUrl: string;

  const VISIBILITY_TIMEOUT_S = 3;

  const receive = (url: string, max = 10, waitSeconds = 1) =>
    sqs
      .send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: max,
          WaitTimeSeconds: waitSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      )
      .then((r) => r.Messages ?? []);

  beforeAll(async () => {
    dlqUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `fidelity-dlq-${suffix}.fifo`,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl as string;
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `fidelity-${suffix}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            VisibilityTimeout: String(VISIBILITY_TIMEOUT_S),
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: Attributes?.QueueArn,
              maxReceiveCount: '2',
            }),
          },
        }),
      )
    ).QueueUrl as string;
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  });

  it('applies FIFO semantics: dedup, group lock, visibility reset and DLQ redrive', async () => {
    // 1. Same MessageDeduplicationId within the window is delivered once.
    for (let i = 0; i < 3; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: 'first',
          MessageGroupId: 'wallet-1',
          MessageDeduplicationId: 'dedup-1',
        }),
      );
    }
    const [first, ...extra] = await receive(queueUrl);
    expect(first?.Body).toBe('first');
    expect(extra).toHaveLength(0);

    // 2. While a message of a group is in flight, the next one of the same group is withheld.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: 'second',
        MessageGroupId: 'wallet-1',
        MessageDeduplicationId: 'dedup-2',
      }),
    );
    // No long polling here: waiting could outlast the visibility timeout of the first message.
    expect(await receive(queueUrl, 10, 0)).toHaveLength(0);

    // 3. Visibility timeout 0 returns the message immediately (used on SIGTERM / transient errors).
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: first?.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    const [again] = await receive(queueUrl, 1);
    expect(again?.Body).toBe('first');
    expect(again?.Attributes?.ApproximateReceiveCount).toBe('2');

    // 4. After maxReceiveCount receives, the message moves to the DLQ and the group unblocks.
    await Bun.sleep(VISIBILITY_TIMEOUT_S * 1_000 + 200);
    const [next] = await receive(queueUrl, 1);
    expect(next?.Body).toBe('second');
    const dead = await receive(dlqUrl);
    expect(dead.map((m) => m.Body)).toEqual(['first']);
  });
});
