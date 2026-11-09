import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionRunner } from '../../application/transaction-runner.port';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * TransactionRunner on top of MikroORM. `transactional()` opens BEGIN/COMMIT on a forked
 * EntityManager and registers it in an AsyncLocalStorage context: every repository call made
 * inside `work` (they all inject the global EntityManager) resolves to this fork, i.e. to the
 * same connection and transaction. An exception thrown by `work` triggers ROLLBACK.
 *
 * Isolation: READ COMMITTED (PostgreSQL default). Correctness comes from row locks and unique
 * constraints, not from SERIALIZABLE retries.
 */
@Injectable()
export class MikroOrmTransactionRunner implements TransactionRunner {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly em: EntityManager,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.lockTimeoutMs = config.database.lockTimeoutMs;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.em.fork().transactional(async (em) => {
      // Bounded wait for row locks: a stuck lock becomes a transient error (retry) instead of
      // an unbounded queue of blocked requests. SET LOCAL lasts until this transaction ends.
      await em.execute(`SET LOCAL lock_timeout = ${this.lockTimeoutMs}`);
      return work();
    });
  }
}
