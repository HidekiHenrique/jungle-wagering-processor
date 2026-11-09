import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** A ledger entry plus its position: the database sequence that makes pagination stable. */
export interface PositionedLedgerEntry {
  sequence: string;
  entry: WalletLedgerEntry;
}

/** Stored balance and ledger-derived balance, read in ONE statement (one consistent snapshot). */
export interface BalanceAudit {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  checkedEntries: number;
}

export interface LedgerRepository {
  /** Append-only: the table rejects UPDATE and DELETE. */
  append(entry: WalletLedgerEntry): Promise<void>;

  /** All entries of a wallet in insertion order. */
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;

  /** Newest first, strictly before `beforeSequence` when given. */
  page(
    walletId: string,
    options: { beforeSequence?: string; limit: number },
  ): Promise<PositionedLedgerEntry[]>;

  /** @returns undefined when the wallet does not exist. */
  auditBalance(walletId: string): Promise<BalanceAudit | undefined>;
}

export const LEDGER_REPOSITORY = Symbol('LedgerRepository');
