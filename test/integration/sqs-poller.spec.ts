import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DeleteMessageCommand, type Message, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  type MessageDecision,
  SqsQueuePoller,
} from '../../src/modules/messaging/infrastructure/sqs/sqs-queue-poller';
import { createTestQueues, type TestQueues, waitFor } from './support/sqs-test-queues';

/** Poller behavior on a real queue, with a handler the test controls. */
let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues({ maxReceiveCount: 5, visibilityTimeout: 30 });
});
afterAll(async () => {
  await queues.destroy();
});

const send = (body: string, group: string) =>
  queues.sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.wager,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: `${group}-${body}-${Bun.randomUUIDv7()}`,
    }),
  );

function poller(handle: (m: Message) => Promise<MessageDecision>) {
  return new SqsQueuePoller(
    queues.sqs,
    {
      name: 'test',
      queueUrl: queues.urls.wager,
      deadLetterQueueUrl: queues.urls.dlq,
      waitTimeSeconds: 1,
      fallbackRetryDelaySeconds: 1,
    },
    { handle },
  );
}

describe('SqsQueuePoller', () => {
  it('graceful stop (SIGTERM): finishes the in-flight message, gives the rest back immediately', async () => {
    await send('first', 'wallet-a');
    await send('second', 'wallet-a');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    const p = poller(async (m) => {
      handled.push(m.Body ?? '');
      if (m.Body === 'first') await gate; // still processing when stop() is called
      return { action: 'ack' };
    });

    p.start();
    await waitFor(async () => handled.includes('first'));
    const stopped = p.stop(5_000);
    release();
    await stopped;

    expect(handled).toEqual(['first']); // 'second' was never started
    // 'first' was acked after finishing; 'second' was released with visibility 0, so it is
    // available right away (no 30 s visibility wait) for another instance.
    const [next] = await queues.receive(queues.urls.wager, { waitSeconds: 1 });
    expect(next?.Body).toBe('second');
    expect(next?.Attributes?.ApproximateReceiveCount).toBe('2');
    await queues.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queues.urls.wager, ReceiptHandle: next?.ReceiptHandle }),
    );
  });

  it('handles groups in parallel and messages of one group in order', async () => {
    for (const n of [1, 2, 3]) {
      await send(`a${n}`, 'group-a');
      await send(`b${n}`, 'group-b');
    }
    const order: string[] = [];
    const p = poller(async (m) => {
      order.push(m.Body ?? '');
      await Bun.sleep(20);
      return { action: 'ack' };
    });

    p.start();
    await waitFor(async () => order.length >= 6);
    await p.stop(5_000);

    expect(order.filter((b) => b.startsWith('a'))).toEqual(['a1', 'a2', 'a3']);
    expect(order.filter((b) => b.startsWith('b'))).toEqual(['b1', 'b2', 'b3']);
  });

  it('dead-letter decision moves the message to the DLQ with its reason', async () => {
    await send('poison', 'group-dlq');
    await poller(async () => ({ action: 'dead-letter', reason: 'INVALID_MESSAGE: test' })).pollOnce();

    const [dead] = await waitFor(async () => {
      const messages = await queues.receive(queues.urls.dlq, { waitSeconds: 1 });
      return messages.length > 0 && messages;
    });
    expect(dead?.Body).toBe('poison');
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe('INVALID_MESSAGE: test');
    expect(await queues.receive(queues.urls.wager)).toHaveLength(0);
  });
});
