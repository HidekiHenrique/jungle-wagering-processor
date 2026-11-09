import type { BackoffPolicy } from '../../../shared/domain/backoff-policy';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { LedgerDirection } from '../../wallets/domain/ledger-direction';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { ALLOWED_REFERENCE_KINDS } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

export interface SettleWagerInput {
  transaction: WagerTransaction;
  /** The wallet named by the transaction, already locked by the caller. */
  wallet: Wallet;
  /** Result of looking up (providerId, referenceExternalTransactionId); undefined if absent. */
  reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND/ROLLBACK already targets `reference`. */
  referenceAlreadyReversed: boolean;
  /** Id for the ledger entry, in case one is produced. */
  ledgerEntryId: string;
  pendingReferencePolicy: BackoffPolicy;
  at: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry?: WalletLedgerEntry }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * Domain service: decides and applies the outcome of one transaction against one wallet.
 *
 * It spans two aggregates (WagerTransaction and Wallet) and reads a third (the reference), which
 * is why it is a function and not a method of either. It is pure domain logic: no I/O. The caller
 * loads and locks data, calls this, and persists whatever changed, all in one SQL transaction.
 *
 * Every rule of challenge §7 lives here, checked in this order:
 *   1. wallet ownership and currency
 *   2. reference: present? settled? same player/wallet/currency/round? allowed kind?
 *      same amount? not reverted yet?
 *   3. balance: enough funds for debits (distinct codes for BET and for reversals)
 */
export function settleWager(input: SettleWagerInput): SettlementOutcome {
  const { transaction: tx, wallet, at } = input;
  if (tx.isTerminal()) throw new InvariantViolationError(`transaction ${tx.id} is already settled`);
  if (tx.walletId !== wallet.id)
    throw new InvariantViolationError(`wallet ${wallet.id} is not the one of ${tx.id}`);

  const reject = (failureCode: FailureCode, exposeBalance = true): SettlementOutcome => {
    tx.reject(failureCode, { at, balanceAfter: exposeBalance ? wallet.balance : undefined });
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };

  // 1. Wallet ownership first: never reveal the balance of a wallet that is not the player's.
  if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletPlayerMismatch, false);
  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);

  // 2. Reference
  const { reference } = input;
  if (tx.referenceExternalTransactionId !== undefined) {
    // Absent, or present but itself still waiting: park this one and retry later.
    if (!reference?.isTerminal()) {
      if (tx.hasExhaustedReferenceAttempts(input.pendingReferencePolicy)) {
        return reject(FailureCode.ReferenceNotFound);
      }
      tx.markPendingReference(at, input.pendingReferencePolicy);
      return { status: WagerTransactionStatus.PendingReference };
    }
    if (reference.status !== WagerTransactionStatus.Processed)
      return reject(FailureCode.ReferenceNotProcessed);

    const sameContext =
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) return reject(FailureCode.ReferenceMismatch);

    if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(reference.kind))
      return reject(FailureCode.ReferenceKindNotAllowed);

    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) return reject(FailureCode.ReferenceAmountMismatch);
      if (input.referenceAlreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
    }
  }

  // 3. Balance
  if (!tx.affectsBalance()) {
    tx.markProcessed({ at, balanceAfter: wallet.balance, referenceTransactionId: reference?.id });
    return { status: WagerTransactionStatus.Processed };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }

  const movement = { entryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at };
  const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed({ at, balanceAfter: ledgerEntry.balanceAfter, referenceTransactionId: reference?.id });
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}
