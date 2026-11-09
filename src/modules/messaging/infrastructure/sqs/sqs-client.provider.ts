import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OnModuleDestroy, Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../shared/infrastructure/config/app-config';
import { createSqsClient } from './sqs-client.factory';

export const SQS_CLIENT = Symbol('SQSClient');

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): SQSClient & OnModuleDestroy =>
    Object.assign(createSqsClient(config), {
      onModuleDestroy(this: SQSClient) {
        this.destroy();
      },
    }),
};

/** Resolves (and caches) queue URLs by name. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((r) => r.QueueUrl as string);
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}

export const QUEUE_URLS = Symbol('QueueUrls');

export const queueUrlsProvider: Provider = {
  provide: QUEUE_URLS,
  inject: [SQS_CLIENT],
  useFactory: (sqs: SQSClient) => new QueueUrls(sqs),
};
