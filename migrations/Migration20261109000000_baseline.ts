import { Migration } from '@mikro-orm/migrations';

/**
 * Baseline: a reusable trigger function that rejects any change to a row.
 * Attached to the ledger table in a later migration, it makes immutability a database
 * guarantee instead of an application convention (README §5, item 9).
 */
export class Migration20261109000000_baseline extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$;
    `);
  }

  override down(): void {
    this.addSql('DROP FUNCTION forbid_mutation();');
  }
}
