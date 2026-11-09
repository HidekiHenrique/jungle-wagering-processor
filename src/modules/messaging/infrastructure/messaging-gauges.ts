import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../shared/infrastructure/config/app-config';
import { PrometheusMetrics } from '../../../shared/infrastructure/metrics/prometheus-metrics';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from './sqs/sqs-client.provider';

/** Scrape-time gauges for the outbox and the DLQ. */
@Injectable()
export class MessagingGauges implements OnModuleInit {
  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queueUrls: QueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const outbox = () =>
      this.em
        .fork()
        .execute<{ pending: string; lag: string | null }[]>(
          `SELECT count(*) AS pending, EXTRACT(EPOCH FROM now() - min(occurred_at)) AS lag
             FROM outbox_messages WHERE published_at IS NULL`,
        )
        .then(([row]) => row);

    this.metrics.registerGauge('outbox_pending_messages', 'Committed events not yet published', async () =>
      Number((await outbox())?.pending ?? 0),
    );
    // Outbox lag: age of the oldest unpublished event. 0 when the outbox is drained.
    this.metrics.registerGauge('outbox_lag_seconds', 'Age of the oldest unpublished outbox event', async () =>
      Number((await outbox())?.lag ?? 0),
    );
    this.metrics.registerGauge(
      'sqs_dlq_messages',
      'Approximate messages in the wager DLQ (application moves and SQS redrive)',
      async () => {
        const { Attributes } = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queueUrls.get(this.config.sqs.wagerDlq),
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        return (
          Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
          Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
        );
      },
    );
  }
}
