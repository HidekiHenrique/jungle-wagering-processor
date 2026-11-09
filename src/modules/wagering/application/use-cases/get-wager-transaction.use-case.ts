import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../../../shared/application/application-error';
import type { WagerTransaction } from '../../domain/wager-transaction';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '../ports/wager-transaction.repository';

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(description: string) {
    super(`Transaction ${description} not found`);
  }
}

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(@Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagers: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.wagers.findById(transactionId);
    if (!transaction) throw new WagerTransactionNotFoundError(transactionId);
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.wagers.findByExternalId(providerId, externalTransactionId);
    if (!transaction) throw new WagerTransactionNotFoundError(`${externalTransactionId} of ${providerId}`);
    return transaction;
  }
}
