import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../src/modules/messaging/infrastructure/sqs/sqs-client.factory';
import { loadConfig } from '../../../src/shared/infrastructure/config/app-config';

export interface TestQueues {
  sqs: SQSClient;
  names: { wager: string; dlq: string; events: string };
  urls: { wager: string; dlq: string; events: string };
  receive(url: string, options?: { max?: number; waitSeconds?: number }): Promise<Message[]>;
  /** Points the app config (read at boot) to these queues. */
  applyToEnv(): void;
  destroy(): Promise<void>;
}

/** Fresh FIFO queues for one suite: isolated from the dev queues and from other suites. */
export async function createTestQueues(options: {
  maxReceiveCount: number;
  visibilityTimeout: number;
}): Promise<TestQueues> {
  const sqs = createSqsClient(loadConfig(process.env));
  const suffix = Bun.randomUUIDv7().slice(-10);
  const names = {
    wager: `t-wager-${suffix}.fifo`,
    dlq: `t-dlq-${suffix}.fifo`,
    events: `t-events-${suffix}.fifo`,
  };
  const create = async (name: string, attributes: Record<string, string> = {}) =>
    (
      await sqs.send(
        new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
      )
    ).QueueUrl as string;

  const dlq = await create(names.dlq);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const wager = await create(names.wager, {
    VisibilityTimeout: String(options.visibilityTimeout),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: String(options.maxReceiveCount),
    }),
  });
  const events = await create(names.events);
  const urls = { wager, dlq, events };

  return {
    sqs,
    names,
    urls,
    receive: async (url, { max = 10, waitSeconds = 0 } = {}) =>
      (
        await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: max,
            WaitTimeSeconds: waitSeconds,
            MessageSystemAttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
        )
      ).Messages ?? [],
    applyToEnv() {
      process.env.SQS_WAGER_QUEUE = names.wager;
      process.env.SQS_WAGER_DLQ = names.dlq;
      process.env.SQS_EVENTS_QUEUE = names.events;
    },
    async destroy() {
      await Promise.all(
        Object.values(urls).map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
      );
      sqs.destroy();
    },
  };
}

/** Polls `check` until it returns a truthy value or the timeout expires. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 8_000,
  everyMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await Bun.sleep(everyMs);
  }
}
