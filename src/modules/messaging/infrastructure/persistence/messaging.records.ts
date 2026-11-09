import { EntitySchema } from '@mikro-orm/core';
import { timestampColumn } from '../../../../shared/infrastructure/database/column-types';

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageRecordSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestampColumn,
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestampColumn, nullable: true },
    publishedAt: { ...timestampColumn, nullable: true },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageRecordSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: timestampColumn,
    processedAt: { ...timestampColumn, nullable: true },
  },
});
