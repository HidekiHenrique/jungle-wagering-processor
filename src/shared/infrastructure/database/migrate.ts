import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/app-config';
import { buildOrmOptions } from './mikro-orm.config';

/**
 * Migration runner (replaces the MikroORM CLI, see ARCHITECTURE.md).
 *
 *   bun run migration:up        apply all pending migrations
 *   bun run migration:down      revert the last executed migration
 *   bun run migration:status    list executed and pending migrations
 */
const command = process.argv[2];

const orm = await MikroORM.init(buildOrmOptions(loadConfig(process.env)));
try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(
        reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert',
      );
      break;
    }
    case 'status': {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      for (const m of executed) console.log(`[x] ${m.name}`);
      for (const m of pending) console.log(`[ ] ${m.name}`);
      break;
    }
    default:
      console.error('Usage: migrate.ts <up|down|status>');
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}
