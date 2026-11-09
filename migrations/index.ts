import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261109000000_baseline } from './Migration20261109000000_baseline';

/** Explicit, ordered registry: no filesystem globbing, identical behavior in dev, tests and prod. */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261109000000_baseline', class: Migration20261109000000_baseline },
];
