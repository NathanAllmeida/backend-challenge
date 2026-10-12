import { Migration } from '@mikro-orm/migrations';

export class Migration20261012000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id varchar(64) NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(20, 2) NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_not_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(64) NOT NULL,
        external_transaction_id varchar(128) NOT NULL,
        idempotency_key varchar(255) NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        player_id varchar(64) NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(16) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        status varchar(20) NOT NULL,
        failure_code varchar(64),
        observed_balance numeric(20, 2),
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_check_at timestamptz,
        processed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_amount_not_negative CHECK (amount >= 0),
        CONSTRAINT wager_transactions_reversal_has_reference CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_failure_code_on_failure CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_on_processed CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_pending_reference_schedule CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL),
        CONSTRAINT wager_transactions_observed_balance_not_negative CHECK (observed_balance IS NULL OR observed_balance >= 0),
        CONSTRAINT wager_transactions_reference_attempts_not_negative CHECK (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`CREATE INDEX wager_transactions_pending_reference_idx ON wager_transactions (next_reference_check_at) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX wager_transactions_wallet_idx ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        position bigint GENERATED ALWAYS AS IDENTITY,
        wallet_id uuid NOT NULL REFERENCES wallets (id) DEFERRABLE INITIALLY DEFERRED,
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        direction varchar(6) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT wallet_ledger_entries_position_unique UNIQUE (position),
        CONSTRAINT wallet_ledger_entries_one_per_transaction UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_not_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          CASE direction
            WHEN 'CREDIT' THEN balance_after = balance_before + amount
            ELSE balance_after = balance_before - amount
          END
        )
      );
    `);
    this.addSql(`CREATE INDEX wallet_ledger_entries_wallet_position_idx ON wallet_ledger_entries (wallet_id, position);`);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_reject_changes() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% is not allowed)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_reject_changes();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_reject_changes();
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_assert_chain() RETURNS trigger AS $$
      DECLARE
        last_balance numeric(20, 2);
      BEGIN
        SELECT balance_after INTO last_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY position DESC
         LIMIT 1;

        IF COALESCE(last_balance, 0) <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected balance_before %, got %',
            NEW.wallet_id, COALESCE(last_balance, 0), NEW.balance_before
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_assert_chain();
    `);

    this.addSql(`
      CREATE FUNCTION wallets_assert_ledger_backed() RETURNS trigger AS $$
      DECLARE
        previous_balance numeric(20, 2) := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.balance END;
        previous_version integer := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.version END;
      BEGIN
        IF NEW.balance = previous_balance THEN
          IF TG_OP = 'UPDATE' AND NEW.version <> OLD.version THEN
            RAISE EXCEPTION 'wallet % version changed without a balance change', NEW.id
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END IF;

        IF TG_OP = 'UPDATE' AND NEW.version <> previous_version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed but version went from % to %', NEW.id, previous_version, NEW.version
            USING ERRCODE = 'check_violation';
        END IF;

        IF NOT EXISTS (
          SELECT 1
            FROM wallet_ledger_entries
           WHERE wallet_id = NEW.id
             AND balance_before = previous_balance
             AND balance_after = NEW.balance
             AND created_at = NEW.updated_at
        ) THEN
          RAISE EXCEPTION 'wallet % balance changed from % to % without a matching ledger entry', NEW.id, previous_balance, NEW.balance
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_backed_by_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_backed();
    `);

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_changes() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
        END IF;

        IF (NEW.idempotency_key, NEW.payload_hash, NEW.provider_id, NEW.external_transaction_id, NEW.wallet_id,
            NEW.player_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id)
           IS DISTINCT FROM
           (OLD.idempotency_key, OLD.payload_hash, OLD.provider_id, OLD.external_transaction_id, OLD.wallet_id,
            OLD.player_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id) THEN
          RAISE EXCEPTION 'business fields of wager transaction % are immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_changes();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(64) NOT NULL,
        message_id varchar(128) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id varchar(64) NOT NULL,
        event_type varchar(64) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        locked_until timestamptz,
        published_at timestamptz,
        last_error text,
        CONSTRAINT outbox_messages_attempts_not_negative CHECK (attempts >= 0)
      );
    `);
    this.addSql(`CREATE INDEX outbox_messages_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_guard_changes();');
    this.addSql('DROP FUNCTION IF EXISTS wallets_assert_ledger_backed();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_assert_chain();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_reject_changes();');
  }
}
