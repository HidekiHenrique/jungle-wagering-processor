import { DecimalType } from '@mikro-orm/core';

/**
 * Shared column definitions for EntitySchema records.
 * Money columns hydrate as strings ("25.00"): never as JS numbers.
 */
export const moneyColumn = { type: new DecimalType('string'), columnType: 'numeric(20,2)' } as const;
export const timestampColumn = { type: 'datetime', columnType: 'timestamptz' } as const;
