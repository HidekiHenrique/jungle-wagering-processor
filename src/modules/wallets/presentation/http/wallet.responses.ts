import type { MoneyProps } from '../../../../shared/domain/money';
import type { ReconciliationReport } from '../../application/use-cases/reconcile-wallet.use-case';
import type { LedgerDirection } from '../../domain/ledger-direction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/** HTTP response shapes: plain JSON, MoneyProps for every amount, ISO dates. */
export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const toWalletResponse = (w: Wallet): WalletResponse => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export const toLedgerEntryResponse = (e: WalletLedgerEntry): LedgerEntryResponse => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export const toReconciliationResponse = (r: ReconciliationReport) => ({
  walletId: r.walletId,
  storedBalance: r.storedBalance.toJSON(),
  calculatedBalance: r.calculatedBalance.toJSON(),
  difference: r.difference.toJSON(),
  consistent: r.consistent,
  checkedEntries: r.checkedEntries,
});
