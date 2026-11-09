import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  BalanceAudit,
  LedgerRepository,
  PositionedLedgerEntry,
} from '../../application/ports/ledger.repository';
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
    return (await this.page(walletId, { limit: Number.MAX_SAFE_INTEGER })).reverse().map((p) => p.entry);
  }

  async page(
    walletId: string,
    options: { beforeSequence?: string; limit: number },
  ): Promise<PositionedLedgerEntry[]> {
    // Keyset pagination on the identity column: stable under concurrent inserts (new entries get
    // higher sequences and never shift older pages), and O(limit) thanks to the (wallet_id, sequence) index.
    const rows = await this.em.execute<LedgerRow[]>(
      `SELECT sequence::text AS sequence, id, wallet_id, transaction_id, direction, amount::text AS amount,
              currency, balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? ${options.beforeSequence ? 'AND sequence < ?' : ''}
        ORDER BY sequence DESC
        LIMIT ?`,
      options.beforeSequence ? [walletId, options.beforeSequence, options.limit] : [walletId, options.limit],
    );
    return rows.map((r) => ({
      sequence: r.sequence,
      entry: LedgerEntryMapper.toDomain({
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        balanceBefore: r.balance_before,
        balanceAfter: r.balance_after,
        createdAt: new Date(r.created_at),
      }),
    }));
  }

  async auditBalance(walletId: string): Promise<BalanceAudit | undefined> {
    // One statement = one snapshot: the stored balance and the ledger sum can never come from
    // different moments, so a concurrent movement cannot fake a divergence.
    const [row] = await this.em.execute<AuditRow[]>(
      `SELECT w.currency,
              w.balance::text AS stored_balance,
              COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text
                AS calculated_balance,
              COUNT(e.id)::int AS checked_entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    return row
      ? {
          currency: row.currency,
          storedBalance: row.stored_balance,
          calculatedBalance: row.calculated_balance,
          checkedEntries: row.checked_entries,
        }
      : undefined;
  }
}

interface LedgerRow {
  sequence: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string | Date;
}

interface AuditRow {
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: number;
}
