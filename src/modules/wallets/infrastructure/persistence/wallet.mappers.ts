import { Money } from '../../../../shared/domain/money';
import type { LedgerDirection } from '../../domain/ledger-direction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { LedgerEntryRecord, WalletRecord } from './wallet.records';

/** Record ⇄ domain translation. Reads always go through `rehydrate`, never through constructors. */
export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: Money.from({ amount: r.balance, currency: r.currency }),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },

  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: r.currency });
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount),
      balanceBefore: money(r.balanceBefore),
      balanceAfter: money(r.balanceAfter),
      createdAt: r.createdAt,
    });
  },

  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      createdAt: e.createdAt,
    };
  },
};
