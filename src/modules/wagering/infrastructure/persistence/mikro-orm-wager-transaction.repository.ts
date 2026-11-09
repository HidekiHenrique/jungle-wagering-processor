import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.record';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(transaction: WagerTransaction): Promise<boolean> {
    // ON CONFLICT DO NOTHING without a target covers both unique constraints (idempotency key
    // and external id). MikroORM's upsert requires one explicit target, hence raw SQL.
    const r = WagerTransactionMapper.toRecord(transaction);
    const result = await this.em.execute(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, balance_after, reference_attempts,
         next_reference_check_at, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        r.id,
        r.providerId,
        r.externalTransactionId,
        r.idempotencyKey,
        r.payloadHash,
        r.walletId,
        r.playerId,
        r.roundId,
        r.gameId,
        r.kind,
        r.amount,
        r.currency,
        r.referenceExternalTransactionId,
        r.referenceTransactionId,
        r.status,
        r.failureCode,
        r.balanceAfter,
        r.referenceAttempts,
        r.nextReferenceCheckAt,
        r.createdAt,
        r.processedAt,
      ],
      'run',
    );
    return (result as { affectedRows?: number }).affectedRows === 1;
  }

  async updateOutcome(transaction: WagerTransaction): Promise<void> {
    const r = WagerTransactionMapper.toRecord(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: r.id },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        balanceAfter: r.balanceAfter,
        referenceAttempts: r.referenceAttempts,
        nextReferenceCheckAt: r.nextReferenceCheckAt,
        processedAt: r.processedAt,
      },
    );
    if (affected !== 1) throw new Error(`wager transaction ${r.id} not found for update`);
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: referenceId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async wakeDependents(settled: WagerTransaction, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId: settled.walletId,
        providerId: settled.providerId,
        referenceExternalTransactionId: settled.externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceCheckAt: { $gt: now },
      },
      { nextReferenceCheckAt: now },
    );
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      {
        fields: ['id', 'walletId'],
        orderBy: { nextReferenceCheckAt: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    return records.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async claimPendingReference(id: string, now: Date): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id, status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, disableIdentityMap: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  private async findOne(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
