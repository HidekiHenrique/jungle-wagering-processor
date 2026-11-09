import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { WALLET_REPOSITORY } from './application/ports/wallet.repository';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet.repository';
import { LedgerEntryRecordSchema, WalletRecordSchema } from './infrastructure/persistence/wallet.records';

@Module({
  imports: [MikroOrmModule.forFeature([WalletRecordSchema, LedgerEntryRecordSchema])],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY],
})
export class WalletsModule {}
