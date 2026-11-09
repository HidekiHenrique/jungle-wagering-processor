import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { OutboxRepository } from '../../application/ports/outbox.repository';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageRecord } from './messaging.records';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) return;
    const records = events.map(OutboxMessage.enqueue).map(
      (m): OutboxMessageRecord => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: { ...m.payload },
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? null,
        publishedAt: m.publishedAt ?? null,
      }),
    );
    await this.em.insertMany(OutboxMessageRecord, records);
  }
}
