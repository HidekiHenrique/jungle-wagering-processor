import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { BackoffPolicy } from '../../shared/domain/backoff-policy';
import { APP_CONFIG, type AppConfig } from '../../shared/infrastructure/config/app-config';
import { SharedModule } from '../../shared/infrastructure/shared.module';
import { MessagingModule } from '../messaging/messaging.module';
import { WalletsModule } from '../wallets/wallets.module';
import { PENDING_REFERENCE_POLICY } from './application/pending-reference-policy';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports/wager-transaction.repository';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { WagerTransactionRecordSchema } from './infrastructure/persistence/wager-transaction.record';

@Module({
  imports: [
    SharedModule,
    WalletsModule,
    MessagingModule,
    MikroOrmModule.forFeature([WagerTransactionRecordSchema]),
  ],
  providers: [
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
    {
      provide: PENDING_REFERENCE_POLICY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => BackoffPolicy.of(config.pendingReference),
    },
    ProcessWagerTransactionUseCase,
    OpenWalletUseCase,
  ],
  exports: [ProcessWagerTransactionUseCase, OpenWalletUseCase],
})
export class WageringModule {}
