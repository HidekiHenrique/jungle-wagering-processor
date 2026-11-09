import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { enrichLogContext } from '../../../../shared/infrastructure/logger/log-context';
import { ProviderAuthGuard } from '../../../../shared/presentation/http/auth/provider-auth.guard';
import { currentCorrelationId } from '../../../../shared/presentation/http/correlation';
import { IdempotencyKey } from '../../../../shared/presentation/http/idempotency-key.decorator';
import { WalletNotFoundError } from '../../../wallets/application/errors';
import { GetWagerTransactionUseCase } from '../../application/use-cases/get-wager-transaction.use-case';
import {
  ProcessWagerTransactionUseCase,
  type WagerTransactionResult,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status';
import { SubmitWagerTransactionDto } from './wager-transaction.dto';
import { toWagerTransactionResponse } from './wager-transaction.responses';

/**
 * Outcome → HTTP status. The provider decides whether to resend from the status alone:
 *   201 applied now · 200 replay of an applied one · 202 accepted, waiting for its reference
 *   422 rejected by a business rule (final; resending replays the same rejection)
 */
function statusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WagerTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerTransactionDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Partial<WagerTransactionResult>> {
    enrichLogContext({ providerId: body.providerId, walletId: body.walletId });
    try {
      const result = await this.processWager.execute({
        ...body,
        idempotencyKey,
        correlationId: currentCorrelationId(),
      });
      enrichLogContext({ transactionId: result.transactionId });
      res.status(statusFor(result));
      return result;
    } catch (error) {
      // An operation for a wallet that does not exist is a business rejection for the provider
      // (do not resend as is), but there is no wallet to attach a persisted transaction to.
      if (error instanceof WalletNotFoundError) {
        res.status(422);
        return {
          status: WagerTransactionStatus.Rejected,
          failureCode: error.code as never,
          idempotentReplay: false,
        };
      }
      throw error;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return toWagerTransactionResponse(await this.getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return toWagerTransactionResponse(
      await this.getTransaction.byExternalId(providerId, externalTransactionId),
    );
  }
}
