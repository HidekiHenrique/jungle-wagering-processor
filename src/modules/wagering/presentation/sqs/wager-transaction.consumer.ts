import { createHash } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { METRICS, type Metrics } from '../../../../shared/application/metrics.port';
import { DomainError } from '../../../../shared/domain/domain-error';
import { APP_CONFIG, type AppConfig } from '../../../../shared/infrastructure/config/app-config';
import { isTransientInfrastructureError } from '../../../../shared/infrastructure/database/transient-error';
import { runWithLogContext } from '../../../../shared/infrastructure/logger/log-context';
import { SqsPollerFactory } from '../../../messaging/infrastructure/sqs/sqs-poller.factory';
import {
  type MessageDecision,
  type QueueMessageHandler,
  retryDelaySeconds,
  type SqsQueuePoller,
} from '../../../messaging/infrastructure/sqs/sqs-queue-poller';
import { WalletNotFoundError } from '../../../wallets/application/errors';
import { ExternalTransactionConflictError, IdempotencyKeyConflictError } from '../../application/errors';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionRequestedMessage } from './wager-transaction-requested.message';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

/** Errors that are a definitive answer for this message: acknowledge, do not retry. */
const BUSINESS_ERRORS = [WalletNotFoundError, IdempotencyKeyConflictError, ExternalTransactionConflictError];

/**
 * SQS adapter of ProcessWagerTransactionUseCase: the same use case as the HTTP controller.
 *
 * Error classification (challenge §10):
 *   business (rejection, conflict, unknown wallet)  → ack; the outcome is final
 *   permanent (malformed message, invalid values)   → DLQ immediately, with the reason
 *   transient (lock timeout, DB/SQS unavailable)    → no ack; visible again after backoff;
 *                                                     after maxReceiveCount SQS moves it to the DLQ
 *   unexpected                                      → treated as transient (bounded by maxReceiveCount)
 */
@Injectable()
export class WagerTransactionConsumer
  implements QueueMessageHandler, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private poller?: SqsQueuePoller;

  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly pollers: SqsPollerFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.workers.consumerEnabled) await this.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.poller) return;
    const startedAt = Date.now();
    this.logger.log({ msg: 'Stopping consumer: finishing in-flight messages', signal });
    await this.stop();
    this.logger.log({ msg: 'Consumer stopped', tookMs: Date.now() - startedAt });
  }

  async start(): Promise<void> {
    this.poller ??= await this.pollers.create(this.config.sqs.wagerQueue, this.config.sqs.wagerDlq, this);
    this.poller.start();
  }

  async stop(): Promise<void> {
    await this.poller?.stop(this.config.workers.shutdownTimeoutMs);
  }

  async handle(message: Message): Promise<MessageDecision> {
    const parsed = await this.parse(message.Body);
    if (typeof parsed === 'string') return this.deadLetter(parsed);
    const { data } = parsed;

    return runWithLogContext(
      {
        correlationId: parsed.messageId,
        messageId: parsed.messageId,
        providerId: data.providerId,
        walletId: data.walletId,
      },
      async () => {
        try {
          const result = await this.processWager.execute({
            ...data,
            correlationId: parsed.messageId,
            inbox: {
              consumerName: WAGER_CONSUMER_NAME,
              messageId: parsed.messageId,
              payloadHash: sha256(message.Body ?? ''),
            },
          });
          this.logger.log({
            msg: 'Wager message processed',
            transactionId: result.transactionId,
            status: result.status,
            idempotentReplay: result.idempotentReplay,
          });
          return { action: 'ack' };
        } catch (error) {
          return this.classify(error, message);
        }
      },
    );
  }

  private classify(error: unknown, message: Message): MessageDecision {
    if (BUSINESS_ERRORS.some((type) => error instanceof type)) {
      this.logger.warn({ msg: 'Wager message rejected', code: (error as { code: string }).code });
      return { action: 'ack' };
    }
    if (error instanceof DomainError) return this.deadLetter(`${error.code}: ${error.message}`);
    const delaySeconds = retryDelaySeconds(
      message,
      this.config.sqs.retryBaseDelaySeconds,
      this.config.sqs.retryMaxDelaySeconds,
    );
    const transient = isTransientInfrastructureError(error);
    this.logger[transient ? 'warn' : 'error']({
      msg: transient ? 'Transient failure; will retry' : 'Unexpected failure; will retry',
      delaySeconds,
      receiveCount: message.Attributes?.ApproximateReceiveCount,
      error: String(error),
    });
    this.metrics.retryScheduled('sqs-message');
    return { action: 'retry', delaySeconds };
  }

  private deadLetter(reason: string): MessageDecision {
    this.metrics.deadLettered(this.config.sqs.wagerQueue);
    return { action: 'dead-letter', reason };
  }

  /** @returns the validated message, or the reason it can never be processed. */
  private async parse(body: string | undefined): Promise<WagerTransactionRequestedMessage | string> {
    let json: unknown;
    try {
      json = JSON.parse(body ?? '');
    } catch {
      return 'INVALID_MESSAGE: body is not JSON';
    }
    const message = plainToInstance(WagerTransactionRequestedMessage, json);
    const errors = await validate(message, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      return `INVALID_MESSAGE: ${errors.map((e) => `${e.property} ${Object.values(e.constraints ?? { nested: 'invalid' }).join(', ')}`).join('; ')}`;
    }
    return message;
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
