import { MikroORM } from '@mikro-orm/postgresql';
import type { DynamicModule, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { OpenWalletUseCase } from '../../../src/modules/wagering/application/use-cases/open-wallet.use-case';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';

export interface TestApp {
  orm: MikroORM;
  openWallet: OpenWalletUseCase;
  processWager: ProcessWagerTransactionUseCase;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule against the test database (no mocks) and rebuilds the schema by
 * running every migration down and up again: each suite starts empty, and reversibility is
 * exercised on every run.
 */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  let builder = Test.createTestingModule({ imports: [AppModule as Type | DynamicModule] });
  if (override) builder = override(builder);
  const moduleRef = await builder.compile();
  moduleRef.useLogger(false);
  await moduleRef.init();

  const orm = moduleRef.get(MikroORM) as unknown as MikroORM;
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  return {
    orm,
    openWallet: moduleRef.get(OpenWalletUseCase),
    processWager: moduleRef.get(ProcessWagerTransactionUseCase),
    sql: (query, params = []) => orm.em.fork().getConnection().execute(query, params) as never,
    get: <T>(token: unknown) => moduleRef.get(token as never) as T,
    close: () => moduleRef.close(),
  };
}

export const uuid = () => Bun.randomUUIDv7();

let counter = 0;
/** A valid BET command; override any field. Unique external id and key per call. */
export function wagerCommand(
  overrides: Partial<ProcessWagerTransactionCommand> &
    Pick<ProcessWagerTransactionCommand, 'walletId' | 'playerId'>,
): ProcessWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${++counter}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'test',
    ...overrides,
  };
}

/** wallet.balance vs. the balance rebuilt from its ledger entries. */
export async function ledgerInvariant(app: TestApp, walletId: string) {
  const [row] = await app.sql<{ stored: string; rebuilt: string; entries: string }>(
    `SELECT w.balance::text AS stored,
            COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS rebuilt,
            COUNT(e.id)::text AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.balance`,
    [walletId],
  );
  return { stored: row?.stored, rebuilt: row?.rebuilt, entries: Number(row?.entries) };
}
