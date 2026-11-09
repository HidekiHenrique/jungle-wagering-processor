import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { INBOX_REPOSITORY } from './application/ports/inbox.repository';
import { OUTBOX_REPOSITORY } from './application/ports/outbox.repository';
import {
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
} from './infrastructure/persistence/messaging.records';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox.repository';

@Module({
  imports: [MikroOrmModule.forFeature([OutboxMessageRecordSchema, InboxMessageRecordSchema])],
  providers: [
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
  ],
  exports: [OUTBOX_REPOSITORY, INBOX_REPOSITORY],
})
export class MessagingModule {}
