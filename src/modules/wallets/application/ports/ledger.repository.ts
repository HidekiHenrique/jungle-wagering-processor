import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerRepository {
  /** Append-only: the table rejects UPDATE and DELETE. */
  append(entry: WalletLedgerEntry): Promise<void>;

  /** All entries of a wallet in insertion order (used by reconciliation and tests). */
  listByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}

export const LEDGER_REPOSITORY = Symbol('LedgerRepository');
