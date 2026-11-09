import { Module } from '@nestjs/common';
import { CLOCK } from '../application/clock.port';
import { ID_GENERATOR } from '../application/id-generator.port';
import { PROVIDER_IDENTITY } from '../application/provider-identity.port';
import { TRANSACTION_RUNNER } from '../application/transaction-runner.port';
import { ProviderAuthGuard } from '../presentation/http/auth/provider-auth.guard';
import { AnonymousProviderIdentity } from './auth/anonymous-provider-identity';
import { MikroOrmTransactionRunner } from './database/mikro-orm-transaction-runner';
import { SystemClock } from './system-clock';
import { UuidV7Generator } from './uuid-v7-generator';

/** Implementations of the shared application ports. Imported explicitly by each module that needs them. */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
    { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
    ProviderAuthGuard,
  ],
  exports: [CLOCK, ID_GENERATOR, TRANSACTION_RUNNER, PROVIDER_IDENTITY, ProviderAuthGuard],
})
export class SharedModule {}
