import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../../../shared/infrastructure/config/app-config';

/** Builds the SQS client for the configured endpoint (MiniStack locally, AWS in a real deploy). */
export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
}
