import type { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../shared/infrastructure/config/app-config';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from './sqs-client.provider';
import { type QueueMessageHandler, SqsQueuePoller } from './sqs-queue-poller';

/** Lets other modules consume a queue without knowing SQS details. */
@Injectable()
export class SqsPollerFactory {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queueUrls: QueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    queueName: string,
    deadLetterQueueName: string,
    handler: QueueMessageHandler,
  ): Promise<SqsQueuePoller> {
    const [queueUrl, deadLetterQueueUrl] = await Promise.all([
      this.queueUrls.get(queueName),
      this.queueUrls.get(deadLetterQueueName),
    ]);
    return new SqsQueuePoller(
      this.sqs,
      {
        name: queueName,
        queueUrl,
        deadLetterQueueUrl,
        waitTimeSeconds: this.config.sqs.waitTimeSeconds,
        fallbackRetryDelaySeconds: this.config.sqs.retryBaseDelaySeconds,
      },
      handler,
    );
  }
}
