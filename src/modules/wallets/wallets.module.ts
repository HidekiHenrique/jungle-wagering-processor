import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/infrastructure/shared.module';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { WALLET_REPOSITORY } from './application/ports/wallet.repository';
import { GetWalletUseCase } from './application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from './application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet.repository';
import { LedgerEntryRecordSchema, WalletRecordSchema } from './infrastructure/persistence/wallet.records';
import { WalletsController } from './presentation/http/wallets.controller';

@Module({
  imports: [SharedModule, MikroOrmModule.forFeature([WalletRecordSchema, LedgerEntryRecordSchema])],
  controllers: [WalletsController],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY],
})
export class WalletsModule {}
