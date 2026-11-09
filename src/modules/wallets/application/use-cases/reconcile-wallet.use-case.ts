import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '../../../../shared/domain/money';
import { WalletNotFoundError } from '../errors';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../ports/ledger.repository';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** stored - calculated */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger.
 * It never fixes anything: a divergence means a bug or a manual change, and silently
 * overwriting either side would destroy the evidence. It is logged and reported instead.
 */
@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(@Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const audit = await this.ledger.auditBalance(walletId);
    if (!audit) throw new WalletNotFoundError(walletId);

    const storedBalance = Money.fromSigned(audit.storedBalance, audit.currency);
    const calculatedBalance = Money.fromSigned(audit.calculatedBalance, audit.currency);
    const difference = storedBalance.subtract(calculatedBalance);
    const report = {
      walletId,
      storedBalance,
      calculatedBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: audit.checkedEntries,
    };

    if (!report.consistent) {
      this.logger.warn({
        msg: 'Wallet balance diverges from its ledger',
        walletId,
        difference: difference.amount,
        checkedEntries: audit.checkedEntries,
      });
    }
    return report;
  }
}
