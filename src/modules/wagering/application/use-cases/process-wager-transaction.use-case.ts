import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../shared/application/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../../shared/application/id-generator.port';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../shared/application/transaction-runner.port';
import type { BackoffPolicy } from '../../../../shared/domain/backoff-policy';
import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import type { EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import { Money, type MoneyProps } from '../../../../shared/domain/money';
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from '../../../messaging/application/ports/inbox.repository';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../../messaging/application/ports/outbox.repository';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import { WalletNotFoundError } from '../../../wallets/application/errors';
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from '../../../wallets/application/ports/ledger.repository';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../../wallets/application/ports/wallet.repository';
import { WalletBalanceChanged } from '../../../wallets/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../../wallets/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import type { FailureCode } from '../../domain/failure-code';
import { type SettlementOutcome, settleWager } from '../../domain/settle-wager';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { ExternalTransactionConflictError, IdempotencyKeyConflictError } from '../errors';
import { hashWagerPayload } from '../payload-hash';
import { PENDING_REFERENCE_POLICY } from '../pending-reference-policy';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../ports/wager-transaction.repository';

/** Input shared by the HTTP controller and the SQS consumer. */
export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  /** Present when the command comes from a queue: deduplicated by the inbox. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the outcome was decided (absent while pending or on foreign wallets). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * The single entry point for provider operations, used by HTTP and SQS alike.
 *
 * One SQL transaction:
 *   1. inbox record (queue only)             → redelivery?  replay
 *   2. insert transaction as PENDING         → duplicate?   replay or 409 (waits on the unique
 *                                              index while a concurrent duplicate is in flight)
 *   3. lock the wallet row (FOR NO KEY UPDATE)
 *   4. load reference + reversal status
 *   5. settleWager (pure domain rules)
 *   6. persist wallet, ledger entry, outcome
 *   7. write integration events to the outbox
 * Any error rolls everything back. Nothing leaves the process before COMMIT.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY) private readonly pendingReferencePolicy: BackoffPolicy,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const now = this.clock.now();
    // Validation happens before opening a transaction: invalid payloads never touch the database.
    const candidate = this.buildTransaction(command, now);

    return this.transactions.run(async () => {
      if (command.inbox) {
        const message = InboxMessage.receive({ ...command.inbox, receivedAt: now });
        message.markProcessed(now);
        if (!(await this.inbox.tryRecord(message))) return this.replay(candidate);
      }

      if (!(await this.wallets.exists(candidate.walletId))) throw new WalletNotFoundError(candidate.walletId);
      if (!(await this.wagers.tryInsert(candidate))) return this.replay(candidate);

      return this.settle(candidate, command, now);
    });
  }

  private buildTransaction(command: ProcessWagerTransactionCommand, now: Date): WagerTransaction {
    const money = Money.from(command.money);
    const payloadHash = hashWagerPayload({ ...command, money: money.toJSON() });
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
  }

  /** The operation already exists: same payload → original result; otherwise → conflict. */
  private async replay(candidate: WagerTransaction): Promise<WagerTransactionResult> {
    const existing = await this.wagers.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(candidate.payloadHash)) {
        throw new IdempotencyKeyConflictError(candidate.providerId, candidate.idempotencyKey);
      }
      return toResult(existing, true);
    }
    if (await this.wagers.findByExternalId(candidate.providerId, candidate.externalTransactionId)) {
      throw new ExternalTransactionConflictError(candidate.providerId, candidate.externalTransactionId);
    }
    throw new InvariantViolationError(`insert of ${candidate.id} conflicted but no conflicting row exists`);
  }

  private async settle(
    transaction: WagerTransaction,
    command: ProcessWagerTransactionCommand,
    now: Date,
  ): Promise<WagerTransactionResult> {
    const wallet = await this.wallets.lockById(transaction.walletId);
    if (!wallet) throw new WalletNotFoundError(transaction.walletId);

    const reference = transaction.referenceExternalTransactionId
      ? await this.wagers.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined &&
      transaction.isReversal() &&
      (await this.wagers.hasProcessedReversal(reference.id));

    const versionBefore = wallet.version;
    const outcome = settleWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      pendingReferencePolicy: this.pendingReferencePolicy,
      at: now,
    });

    const ledgerEntry = outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry) {
      await this.wallets.updateBalance(wallet, versionBefore);
      await this.ledger.append(ledgerEntry);
    }
    await this.wagers.updateOutcome(transaction);
    await this.outbox.add(this.eventsFor(transaction, wallet, outcome, command, now));

    return toResult(transaction, false);
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    command: ProcessWagerTransactionCommand,
    now: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId,
      occurredAt: now,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return outcome.ledgerEntry
          ? [
              WagerTransactionProcessed.from(transaction, ctx()),
              WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx()),
            ]
          : [WagerTransactionProcessed.from(transaction, ctx())];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, ctx())];
      case WagerTransactionStatus.PendingReference:
        return [WagerTransactionPendingReference.from(transaction, ctx())];
    }
  }
}

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.balanceAfter ? { balance: transaction.balanceAfter.toJSON() } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}
