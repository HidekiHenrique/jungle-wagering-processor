import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ProviderAuthGuard } from '../../../../shared/presentation/http/auth/provider-auth.guard';
import { GetWalletUseCase } from '../../application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { toLedgerEntryResponse, toReconciliationResponse, toWalletResponse } from './wallet.responses';

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

/** Thin adapter: validate, delegate, shape the response. No business rules here. */
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Get(':walletId')
  async findOne(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return toWalletResponse(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId', ParseUUIDPipe) walletId: string, @Query() query: LedgerQueryDto) {
    const page = await this.getLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
    return { items: page.items.map(toLedgerEntryResponse), nextCursor: page.nextCursor };
  }

  /** POST because it is an explicit audit action (logged, counted), even though it changes nothing. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return toReconciliationResponse(await this.reconcile.execute(walletId));
  }
}
