import { Migration } from '@mikro-orm/migrations';

/**
 * Core financial schema. Every guarantee the challenge lists in §6 is enforced here, by the
 * database, not only by application code (§5, item 9):
 *
 *   uniqueness      wallets(player_id, currency); transactions(provider_id, idempotency_key) and
 *                   (provider_id, external_transaction_id); one ledger entry per transaction;
 *                   one PROCESSED reversal per reference; inbox (consumer_name, message_id)
 *   non-negativity  CHECK (balance >= 0), CHECK (amount > 0) on ledger entries
 *   immutability    ledger rejects UPDATE/DELETE/TRUNCATE (trigger)
 *   consistency     ledger arithmetic, ledger currency = wallet currency, status/field coherence,
 *                   PENDING can never be committed (deferred constraint trigger)
 */
export class Migration20261109010000_core_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2)  NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
        -- Target of the ledger's composite FK: an entry can only use its wallet's currency.
        CONSTRAINT wallets_id_currency_key UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        text           NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id            text           NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key                    text           NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        payload_hash                       text           NOT NULL CHECK (length(payload_hash) > 0),
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          uuid           NOT NULL,
        round_id                           text           NOT NULL CHECK (length(round_id) BETWEEN 1 AND 128),
        game_id                            text           NOT NULL CHECK (length(game_id) BETWEEN 1 AND 128),
        kind                               text           NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20,2)  NOT NULL CHECK (amount >= 0),
        currency                           char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text           CHECK (length(reference_external_transaction_id) BETWEEN 1 AND 128),
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             text           NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        balance_after                      numeric(20,2)  CHECK (balance_after >= 0),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,

        CONSTRAINT wager_transactions_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),

        -- OPENING exists only under the reserved internal provider, and vice versa.
        CONSTRAINT wager_transactions_opening_is_internal
          CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
        CONSTRAINT wager_transactions_reversal_has_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_failure_code_iff_failed
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_has_outcome
          CHECK (status <> 'PROCESSED' OR (balance_after IS NOT NULL AND processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_reversal_resolved
          CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL)
      );
    `);

    // A reference can be reverted once, by REFUND or ROLLBACK (decision A1). Rejected reversals
    // stay out of the index, so they remain auditable without blocking anything.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql('CREATE INDEX wager_transactions_wallet ON wager_transactions (wallet_id, created_at);');

    // PENDING is the transient state inside the settling transaction. If a bug ever commits it,
    // this deferred check (run at COMMIT, on the row's final state) aborts the whole transaction.
    this.addSql(`
      CREATE FUNCTION wager_transactions_forbid_pending_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM wager_transactions WHERE id = NEW.id AND status = 'PENDING') THEN
          RAISE EXCEPTION 'wager transaction % cannot be committed as PENDING', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wager_transactions_no_pending_commit
        AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_forbid_pending_commit();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        sequence        bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       text           NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20,2)  NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(20,2)  NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2)  NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz    NOT NULL,

        -- At most one entry per financial transaction (and so per wallet).
        CONSTRAINT wallet_ledger_entries_transaction_key UNIQUE (transaction_id),
        CONSTRAINT wallet_ledger_entries_wallet_currency_fkey
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql('CREATE INDEX wallet_ledger_entries_wallet ON wallet_ledger_entries (wallet_id, sequence);');
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text         NOT NULL CHECK (length(consumer_name) > 0),
        message_id     text         NOT NULL CHECK (length(message_id) > 0),
        payload_hash   text         NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        aggregate_id     text         NOT NULL,
        event_type       text         NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending
        ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages;');
    this.addSql('DROP TABLE inbox_messages;');
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP FUNCTION wager_transactions_forbid_pending_commit();');
    this.addSql('DROP TABLE wallets;');
  }
}
