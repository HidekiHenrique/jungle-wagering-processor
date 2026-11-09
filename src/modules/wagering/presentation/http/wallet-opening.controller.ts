import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../../../../shared/presentation/http/auth/provider-auth.guard';
import { currentCorrelationId } from '../../../../shared/presentation/http/correlation';
import { OpenWalletUseCase } from '../../application/use-cases/open-wallet.use-case';
import { OpenWalletDto } from './wager-transaction.dto';

/**
 * POST /wallets lives in wagering because opening a wallet with balance writes an OPENING
 * transaction. The route does not decide the module: dependencies do.
 */
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletOpeningController {
  constructor(private readonly openWallet: OpenWalletUseCase) {}

  @Post()
  async open(@Body() body: OpenWalletDto) {
    return this.openWallet.execute({ ...body, correlationId: currentCorrelationId() });
  }
}
