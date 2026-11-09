import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/infrastructure/shared.module';
import { INBOX_REPOSITORY } from './application/ports/inbox.repository';
import { OUTBOX_REPOSITORY } from './application/ports/outbox.repository';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import {
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
} from './infrastructure/persistence/messaging.records';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox.repository';
import {
  QUEUE_URLS,
  queueUrlsProvider,
  SQS_CLIENT,
  sqsClientProvider,
} from './infrastructure/sqs/sqs-client.provider';
import { SqsPollerFactory } from './infrastructure/sqs/sqs-poller.factory';

@Module({
  imports: [SharedModule, MikroOrmModule.forFeature([OutboxMessageRecordSchema, InboxMessageRecordSchema])],
  providers: [
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
    sqsClientProvider,
    queueUrlsProvider,
    SqsPollerFactory,
    OutboxRelay,
  ],
  exports: [OUTBOX_REPOSITORY, INBOX_REPOSITORY, SQS_CLIENT, QUEUE_URLS, SqsPollerFactory, OutboxRelay],
})
export class MessagingModule {}
