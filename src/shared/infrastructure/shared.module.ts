import { Module } from '@nestjs/common';
import { CLOCK } from '../application/clock.port';
import { ID_GENERATOR } from '../application/id-generator.port';
import { TRANSACTION_RUNNER } from '../application/transaction-runner.port';
import { MikroOrmTransactionRunner } from './database/mikro-orm-transaction-runner';
import { SystemClock } from './system-clock';
import { UuidV7Generator } from './uuid-v7-generator';

/** Implementations of the shared application ports. Imported explicitly by each module that needs them. */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
  ],
  exports: [CLOCK, ID_GENERATOR, TRANSACTION_RUNNER],
})
export class SharedModule {}
