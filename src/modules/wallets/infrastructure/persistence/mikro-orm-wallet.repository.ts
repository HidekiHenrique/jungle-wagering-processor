import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { ConcurrentModificationError } from '../../../../shared/application/application-error';
import { WalletAlreadyExistsError, type WalletRepository } from '../../application/ports/wallet.repository';
import type { Wallet } from '../../domain/wallet';
import { WalletMapper } from './wallet.mappers';
import { WalletRecord } from './wallet.records';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  // The injected EntityManager is the global one; MikroORM resolves each call to the current
  // transaction (TransactionContext) or request fork, so this repository joins whatever unit of
  // work is active.
  constructor(private readonly em: EntityManager) {}

  async exists(id: string): Promise<boolean> {
    return (await this.em.count(WalletRecord, { id })) > 0;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    // FOR NO KEY UPDATE, not FOR UPDATE: it blocks other writers of this wallet but not the
    // KEY SHARE lock that inserting a row with an FK to it takes. MikroORM's LockMode only offers
    // FOR UPDATE, hence raw SQL here.
    const rows = await this.em.execute<WalletRow[]>(
      `SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at
         FROM wallets WHERE id = ? FOR NO KEY UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return WalletMapper.toDomain({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: row.balance,
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        constraintOf(error) === 'wallets_player_currency_key'
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new ConcurrentModificationError('Wallet', wallet.id);
  }
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export function constraintOf(error: unknown): string | undefined {
  return (error as { constraint?: string }).constraint;
}
