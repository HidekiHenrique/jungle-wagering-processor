import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../../migrations';
import type { AppConfig } from '../config/app-config';

/**
 * Single source of MikroORM options, shared by the Nest app and the migration runner.
 *
 * Migrations are written by hand in SQL and registered explicitly in `migrations/index.ts`:
 * the schema relies on CHECKs, triggers and partial unique indexes that a diff generator
 * does not express, so schema snapshots are disabled.
 */
export function buildOrmOptions(config: AppConfig): Options {
  return defineConfig({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    dbName: config.database.name,
    pool: { min: 0, max: config.database.poolMax },
    entities: [],
    discovery: { warnWhenNoEntities: false },
    // Every unit of work must run in an explicit, forked context (request, message or job).
    allowGlobalContext: false,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList,
      snapshot: false,
      snapshotOnMigrate: false,
      transactional: true,
      allOrNothing: true,
    },
  });
}
