import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { InboxRepository } from '../../application/ports/inbox.repository';
import type { InboxMessage } from '../../domain/inbox-message';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryRecord(message: InboxMessage): Promise<boolean> {
    // The primary key (consumer_name, message_id) is the deduplication: a redelivery that races
    // with the first delivery waits on the key and then inserts nothing.
    const result = await this.em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
    return (result as { affectedRows?: number }).affectedRows === 1;
  }
}
