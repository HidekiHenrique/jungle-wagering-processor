import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';

/** What to do with a message after handling it. */
export type MessageDecision =
  /** Done (applied, replayed, or rejected by a business rule): delete it. */
  | { action: 'ack' }
  /** Transient failure: keep it, make it visible again after `delaySeconds`. */
  | { action: 'retry'; delaySeconds: number }
  /** Can never succeed (e.g. malformed): move it to the DLQ now instead of burning retries. */
  | { action: 'dead-letter'; reason: string };

export interface QueueMessageHandler {
  handle(message: Message): Promise<MessageDecision>;
}

export interface PollerOptions {
  name: string;
  queueUrl: string;
  deadLetterQueueUrl: string;
  waitTimeSeconds: number;
  /** Delay used when the handler throws instead of returning a decision. */
  fallbackRetryDelaySeconds: number;
}

/**
 * Long-polling loop over one SQS queue. Knows nothing about wagers: it receives, hands each
 * message to the handler and applies the returned decision.
 *
 * - Ack only after the handler returns, i.e. after its database transaction committed.
 * - FIFO: messages of the same MessageGroupId are handled sequentially, groups in parallel.
 * - stop(): stops receiving, lets in-flight messages finish, and gives the not-yet-started ones
 *   back to the queue immediately (visibility 0) so another instance can take them.
 *   The current long poll is NOT aborted: SQS may already have handed messages to that request,
 *   and aborting it client-side would leave them invisible (unprocessed) until their visibility
 *   timeout. Instead the poll is allowed to return (<= waitTimeSeconds) and whatever it brought
 *   is released. Hence: shutdown timeout > waitTimeSeconds.
 * - If the process dies, nothing is lost: unacked messages reappear after the visibility timeout.
 */
export class SqsQueuePoller {
  private readonly logger: Logger;
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: PollerOptions,
    private readonly handler: QueueMessageHandler,
  ) {
    this.logger = new Logger(`SqsQueuePoller:${options.name}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Graceful stop. Resolves when in-flight work finished (or `timeoutMs` elapsed). */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    const timedOut = Symbol('timeout');
    const result = await Promise.race([this.loop, Bun.sleep(timeoutMs).then(() => timedOut)]);
    if (result === timedOut)
      this.logger.warn({ msg: 'Stop timed out; unfinished messages will reappear later' });
    this.running = false;
  }

  /** Receives and processes one batch. Exposed for tests; the loop calls it repeatedly. */
  async pollOnce(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = response.Messages ?? [];
    if (this.stopping) {
      await this.release(messages); // arrived after stop(): hand them back untouched
      return messages.length;
    }

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error({ msg: 'Receive failed; backing off', error: String(error) });
        await Bun.sleep(1_000);
      }
    }
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await this.release(messages.slice(index));
        return;
      }
      await this.process(message);
    }
  }

  private async process(message: Message): Promise<void> {
    let decision: MessageDecision;
    try {
      decision = await this.handler.handle(message);
    } catch (error) {
      this.logger.error({
        msg: 'Handler threw; will retry',
        messageId: message.MessageId,
        error: String(error),
      });
      decision = { action: 'retry', delaySeconds: this.options.fallbackRetryDelaySeconds };
    }
    try {
      await this.apply(message, decision);
    } catch (error) {
      // The decision could not be applied (e.g. SQS unreachable). Safe: the message reappears
      // after its visibility timeout and is deduplicated by the inbox.
      this.logger.error({ msg: 'Could not apply decision', decision: decision.action, error: String(error) });
    }
  }

  private async apply(message: Message, decision: MessageDecision): Promise<void> {
    const { queueUrl } = this.options;
    switch (decision.action) {
      case 'ack':
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        return;
      case 'retry':
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: decision.delaySeconds,
          }),
        );
        return;
      case 'dead-letter':
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.options.deadLetterQueueUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: {
              deadLetterReason: { DataType: 'String', StringValue: decision.reason.slice(0, 256) },
              sourceQueue: { DataType: 'String', StringValue: this.options.name },
            },
          }),
        );
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        this.logger.warn({
          msg: 'Message moved to DLQ',
          messageId: message.MessageId,
          reason: decision.reason,
        });
        return;
    }
  }

  /** Gives messages back to the queue right away (used on shutdown). */
  private async release(messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((m) =>
        this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.options.queueUrl,
              ReceiptHandle: m.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch(() => undefined),
      ),
    );
  }
}

/** Exponential backoff in seconds from SQS's ApproximateReceiveCount (1 on first delivery). */
export function retryDelaySeconds(message: Message, baseSeconds: number, maxSeconds: number): number {
  const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? '1'));
  return Math.min(baseSeconds * 2 ** Math.min(receiveCount - 1, 20), maxSeconds);
}
