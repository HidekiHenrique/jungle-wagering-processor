import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../shared/application/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../../shared/application/id-generator.port';
import { METRICS, type Metrics } from '../../../../shared/application/metrics.port';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../shared/application/transaction-runner.port';
import {
  TRANSIENT_ERROR_CLASSIFIER,
  type TransientErrorClassifier,
} from '../../../../shared/application/transient-error-classifier.port';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../../wallets/application/ports/wallet.repository';
import { FailureCode } from '../../domain/failure-code';
import type { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../ports/wager-transaction.repository';
import { WagerSettlementService } from '../wager-settlement.service';

export interface PendingReferenceRun {
  /** Transactions this run settled or re-parked. */
  handled: number;
  /** Final status counts of what this run handled. */
  outcomes: Partial<Record<WagerTransactionStatus, number>>;
  /** Candidates taken by another worker (or settled meanwhile). */
  skipped: number;
  /** Transient failures: left as they are, retried next run. */
  transientFailures: number;
  /** Permanent failures: marked FAILED (PROCESSING_FAILED). */
  failed: number;
}

/**
 * Retries PENDING_REFERENCE transactions whose next check is due (challenge §7.1).
 *
 * One SQL transaction per candidate, with the SAME lock order as the first attempt:
 *   1. wallet row      (FOR NO KEY UPDATE)
 *   2. transaction row (FOR UPDATE SKIP LOCKED, re-checking it is still pending and due)
 * Same order everywhere means no deadlock with regular operations; SKIP LOCKED means two
 * workers never settle the same transaction. Settlement itself is WagerSettlementService, so the
 * retry applies exactly the rules of the first attempt; settleWager gives up with
 * REFERENCE_NOT_FOUND once the backoff policy's attempts are exhausted.
 */
@Injectable()
export class ProcessPendingReferencesUseCase {
  private readonly logger = new Logger(ProcessPendingReferencesUseCase.name);

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(TRANSIENT_ERROR_CLASSIFIER) private readonly errors: TransientErrorClassifier,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly settlement: WagerSettlementService,
  ) {}

  async execute(limit: number): Promise<PendingReferenceRun> {
    const run: PendingReferenceRun = {
      handled: 0,
      outcomes: {},
      skipped: 0,
      transientFailures: 0,
      failed: 0,
    };
    const candidates = await this.transactions.run(() =>
      this.wagers.findDuePendingReferences(this.clock.now(), limit),
    );

    for (const candidate of candidates) {
      try {
        const status = await this.retry(candidate);
        if (status) {
          run.handled++;
          run.outcomes[status] = (run.outcomes[status] ?? 0) + 1;
        } else {
          run.skipped++;
        }
      } catch (error) {
        if (this.errors.isTransient(error)) {
          run.transientFailures++;
          this.metrics.retryScheduled('pending-reference');
          this.logger.warn({
            msg: 'Pending reference retry failed; will retry',
            transactionId: candidate.id,
            error: String(error),
          });
        } else {
          run.failed++;
          await this.markFailed(candidate, error);
        }
      }
    }
    return run;
  }

  private retry(candidate: { id: string; walletId: string }): Promise<WagerTransactionStatus | undefined> {
    return this.transactions.run(async () => {
      const now = this.clock.now();
      const wallet = await this.wallets.lockById(candidate.walletId);
      const transaction = wallet && (await this.wagers.claimPendingReference(candidate.id, now));
      if (!wallet || !transaction) return undefined;

      await this.settlement.settle(transaction, wallet, {
        correlationId: this.ids.next(),
        causationId: transaction.id,
        channel: 'pending-reference',
        now,
      });
      return transaction.status;
    });
  }

  /**
   * A non-transient error (a bug, a broken invariant) would otherwise make this transaction fail
   * on every run forever. FAILED keeps it auditable and stops the loop.
   */
  private async markFailed(candidate: { id: string; walletId: string }, error: unknown): Promise<void> {
    this.logger.error({
      msg: 'Pending reference retry failed permanently',
      transactionId: candidate.id,
      error: String(error),
    });
    try {
      await this.transactions.run(async () => {
        const now = this.clock.now();
        await this.wallets.lockById(candidate.walletId);
        const transaction = await this.wagers.claimPendingReference(candidate.id, now);
        if (!transaction) return;
        transaction.fail(FailureCode.ProcessingFailed, now);
        await this.wagers.updateOutcome(transaction);
      });
    } catch (markError) {
      this.logger.error({
        msg: 'Could not mark as FAILED',
        transactionId: candidate.id,
        error: String(markError),
      });
    }
  }
}
