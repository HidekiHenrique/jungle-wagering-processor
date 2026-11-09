import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../../shared/application/id-generator.port';
import type { BackoffPolicy } from '../../../shared/domain/backoff-policy';
import type { EventContext, IntegrationEvent } from '../../../shared/domain/integration-event';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../messaging/application/ports/outbox.repository';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../../wallets/application/ports/ledger.repository';
import { WALLET_REPOSITORY, type WalletRepository } from '../../wallets/application/ports/wallet.repository';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../wallets/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import { type SettlementOutcome, settleWager } from '../domain/settle-wager';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { PENDING_REFERENCE_POLICY } from './pending-reference-policy';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from './ports/wager-transaction.repository';

export interface SettlementContext {
  correlationId: string;
  causationId?: string | undefined;
  now: Date;
}

/**
 * Settles a persisted transaction against its already locked wallet and writes every
 * consequence: wallet, ledger entry, outcome and outbox events. Shared by the first attempt
 * (ProcessWagerTransactionUseCase) and the retries of PENDING_REFERENCE transactions
 * (ProcessPendingReferencesUseCase), so both paths apply exactly the same rules and writes.
 *
 * Must run inside TransactionRunner.run(), with the wallet locked by the caller.
 */
@Injectable()
export class WagerSettlementService {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY) private readonly pendingReferencePolicy: BackoffPolicy,
  ) {}

  async settle(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: SettlementContext,
  ): Promise<SettlementOutcome> {
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
      at: ctx.now,
    });

    const ledgerEntry = outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry) {
      await this.wallets.updateBalance(wallet, versionBefore);
      await this.ledger.append(ledgerEntry);
    }
    await this.wagers.updateOutcome(transaction);
    if (transaction.isTerminal()) {
      // Operations parked waiting for this one can be retried right away instead of after their backoff.
      await this.wagers.wakeDependents(transaction, ctx.now);
    }
    await this.outbox.add(this.eventsFor(transaction, wallet, outcome, ctx));
    return outcome;
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    ctx: SettlementContext,
  ): IntegrationEvent<unknown>[] {
    const event = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return outcome.ledgerEntry
          ? [
              WagerTransactionProcessed.from(transaction, event()),
              WalletBalanceChanged.from(wallet, outcome.ledgerEntry, event()),
            ]
          : [WagerTransactionProcessed.from(transaction, event())];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, event())];
      case WagerTransactionStatus.PendingReference:
        // Announced once, when the transaction is first parked; retries are not news.
        return transaction.referenceAttempts === 1
          ? [WagerTransactionPendingReference.from(transaction, event())]
          : [];
    }
  }
}
