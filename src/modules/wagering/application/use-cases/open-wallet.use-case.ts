import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../shared/application/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../../shared/application/id-generator.port';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../../../shared/application/transaction-runner.port';
import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import { Money, type MoneyProps } from '../../../../shared/domain/money';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '../../../messaging/application/ports/outbox.repository';
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from '../../../wallets/application/ports/ledger.repository';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../../wallets/application/ports/wallet.repository';
import { WalletBalanceChanged } from '../../../wallets/domain/events/wallet-balance-changed.event';
import { Wallet } from '../../../wallets/domain/wallet';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-events';
import { WagerTransaction } from '../../domain/wager-transaction';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../ports/wager-transaction.repository';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Creates a wallet. A positive initial balance is a financial movement like any other:
 * an internal OPENING transaction, its CREDIT ledger entry and its events, all in the same
 * SQL transaction as the wallet row (challenge §9).
 *
 * Lives in `wagering` because it writes a WagerTransaction; `wallets` never depends on `wagering`.
 */
@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const now = this.clock.now();
    const initialBalance = Money.from(command.initialBalance);
    const walletId = this.ids.next();

    const opening = initialBalance.isPositive()
      ? WagerTransaction.opening({
          id: this.ids.next(),
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          createdAt: now,
        })
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      ...(opening ? { opening: { transactionId: opening.id, entryId: this.ids.next() } } : {}),
    });
    opening?.markProcessed({ at: now, balanceAfter: initialBalance });

    await this.transactions.run(async () => {
      await this.wallets.insert(wallet);
      if (!opening || !openingEntry) return;

      if (!(await this.wagers.tryInsert(opening))) {
        throw new InvariantViolationError(`OPENING of new wallet ${walletId} already exists`);
      }
      await this.ledger.append(openingEntry);
      const ctx = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: now });
      await this.outbox.add([
        WagerTransactionProcessed.from(opening, ctx()),
        WalletBalanceChanged.from(wallet, openingEntry, ctx()),
      ]);
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
