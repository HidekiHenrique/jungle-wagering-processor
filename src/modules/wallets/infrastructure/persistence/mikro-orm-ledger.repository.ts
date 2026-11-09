import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { LedgerRepository } from '../../application/ports/ledger.repository';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntryMapper } from './wallet.mappers';
import { LedgerEntryRecord } from './wallet.records';

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async listByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId },
      { orderBy: { sequence: 'asc' }, disableIdentityMap: true },
    );
    return records.map(LedgerEntryMapper.toDomain);
  }
}
