import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../shared/application/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../../shared/application/id-generator.port';
import { METRICS, type Metrics } from '../../../../shared/application/metrics.port';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../shared/application/transaction-runner.port';
import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import { Money, type MoneyProps } from '../../../../shared/domain/money';
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from '../../../messaging/application/ports/inbox.repository';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import { WalletNotFoundError } from '../../../wallets/application/errors';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../../wallets/application/ports/wallet.repository';
import type { FailureCode } from '../../domain/failure-code';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { ExternalTransactionConflictError, IdempotencyKeyConflictError } from '../errors';
import { hashWagerPayload } from '../payload-hash';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../ports/wager-transaction.repository';
import { WagerSettlementService } from '../wager-settlement.service';

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
 *   4-7. WagerSettlementService: reference, settleWager (pure rules), wallet + ledger + outcome,
 *        outbox events (the same code path the pending-reference retries use)
 * Any error rolls everything back. Nothing leaves the process before COMMIT.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly settlement: WagerSettlementService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const now = this.clock.now();
    // Validation happens before opening a transaction: invalid payloads never touch the database.
    const candidate = this.buildTransaction(command, now);

    const startedAt = performance.now();
    const result = await this.transactions.run(async () => {
      if (command.inbox) {
        const message = InboxMessage.receive({ ...command.inbox, receivedAt: now });
        message.markProcessed(now);
        if (!(await this.inbox.tryRecord(message))) return this.replay(candidate, 'inbox');
      }

      if (!(await this.wallets.exists(candidate.walletId))) throw new WalletNotFoundError(candidate.walletId);
      if (!(await this.wagers.tryInsert(candidate))) return this.replay(candidate, 'idempotency-key');

      return this.settle(candidate, command, now);
    });
    this.metrics.processingDuration(channelOf(command), (performance.now() - startedAt) / 1_000);
    return result;
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
  private async replay(
    candidate: WagerTransaction,
    source: 'inbox' | 'idempotency-key',
  ): Promise<WagerTransactionResult> {
    const existing = await this.wagers.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(candidate.payloadHash)) {
        throw new IdempotencyKeyConflictError(candidate.providerId, candidate.idempotencyKey);
      }
      this.metrics.duplicateDetected(source);
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
    await this.settlement.settle(transaction, wallet, {
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId,
      channel: channelOf(command),
      now,
    });
    return toResult(transaction, false);
  }
}

const channelOf = (command: ProcessWagerTransactionCommand) => (command.inbox ? 'sqs' : 'http');

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.balanceAfter ? { balance: transaction.balanceAfter.toJSON() } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}
