import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { databaseConfig } from '@/infrastructure/database/mikro-orm.config';
import { resetDatabase, Sql } from '../support/harness';

let sql: Sql;

const now = '2026-07-29T15:00:00Z';

async function insertWallet(balance = '0.00', playerId = `player-${uuidv7()}`): Promise<string> {
  const id = uuidv7();
  await sql.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', ?, 1, ?, ?)`,
    [id, playerId, balance, now, now],
  );
  return id;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  const external = `ext-${id}`;
  const row = {
    id,
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: 'player',
    round_id: 'round',
    game_id: 'game',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PROCESSED',
    processed_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const columns = Object.keys(row);

  await sql.query(
    `INSERT INTO wager_transactions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );

  return id;
}

async function insertLedger(walletId: string, transactionId: string, direction: string, amount: string, before: string, after: string, run = sql.query.bind(sql)) {
  await run(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, ?)`,
    [uuidv7(), walletId, transactionId, direction, amount, before, after, now],
  );
}

async function creditInTransaction(walletId: string, transactionId: string): Promise<void> {
  await sql.transaction(async (run) => {
    await insertLedger(walletId, transactionId, 'CREDIT', '10.00', '0.00', '10.00', run);
    await run('UPDATE wallets SET balance = 10.00, version = 2, updated_at = ? WHERE id = ?', [now, walletId]);
  });
}

describe('database schema guarantees', () => {
  beforeAll(async () => {
    await resetDatabase();
    sql = await Sql.connect();
  });

  afterAll(async () => {
    await sql.close();
  });

  it('migrations are reversible', async () => {
    const orm = await MikroORM.init(databaseConfig({ poolMax: 2 }));

    try {
      const migrator = orm.getMigrator();
      await migrator.down();
      expect(await orm.em.getConnection().execute(`SELECT to_regclass('public.wallets') AS t`)).toEqual([{ t: null }]);
      await migrator.up();
      expect(await orm.em.getConnection().execute(`SELECT to_regclass('public.wallets')::text AS t`)).toEqual([{ t: 'wallets' }]);
    } finally {
      await orm.close(true);
    }
  });

  it('rejects a negative wallet balance', async () => {
    const walletId = await insertWallet();
    await expect(sql.query('UPDATE wallets SET balance = -1, version = 2 WHERE id = ?', [walletId])).rejects.toThrow(/wallets_balance_not_negative/);
  });

  it('allows only one wallet per player and currency', async () => {
    await insertWallet('0.00', 'same-player');
    await expect(insertWallet('0.00', 'same-player')).rejects.toThrow(/wallets_player_currency_unique/);
  });

  it('rejects a balance change without a matching ledger entry at commit time', async () => {
    const walletId = await insertWallet();
    await expect(sql.query(`UPDATE wallets SET balance = 50, version = 2, updated_at = now() WHERE id = ?`, [walletId])).rejects.toThrow(/without a matching ledger entry/);
  });

  it('rejects a balance change that skips the version increment', async () => {
    const walletId = await insertWallet();
    await expect(sql.query(`UPDATE wallets SET balance = 0.00, version = 5 WHERE id = ?`, [walletId])).rejects.toThrow(/version changed without a balance change/);
  });

  it('enforces idempotency key and external id uniqueness', async () => {
    const walletId = await insertWallet();
    const id = await insertTransaction(walletId, { idempotency_key: 'dup-key', external_transaction_id: 'dup-1' });

    expect(id).toBeString();
    await expect(insertTransaction(walletId, { idempotency_key: 'dup-key', external_transaction_id: 'dup-2' })).rejects.toThrow(/wager_transactions_idempotency_key_unique/);
    await expect(insertTransaction(walletId, { idempotency_key: 'other-key', external_transaction_id: 'dup-1' })).rejects.toThrow(/wager_transactions_provider_external_unique/);
  });

  it('requires a reference for REFUND and ROLLBACK', async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { kind: 'REFUND' })).rejects.toThrow(/wager_transactions_reversal_has_reference/);
  });

  it('allows a reference to be reversed only once', async () => {
    const walletId = await insertWallet();
    const betId = await insertTransaction(walletId);
    const reversal = { reference_external_transaction_id: 'bet', reference_transaction_id: betId };

    await insertTransaction(walletId, { kind: 'REFUND', ...reversal });
    await expect(insertTransaction(walletId, { kind: 'ROLLBACK', ...reversal })).rejects.toThrow(/wager_transactions_single_reversal/);
  });

  it('keeps terminal transactions immutable and forbids deletes', async () => {
    const walletId = await insertWallet();
    const id = await insertTransaction(walletId);

    await expect(sql.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [id])).rejects.toThrow(/is terminal/);
    await expect(sql.query('DELETE FROM wager_transactions WHERE id = ?', [id])).rejects.toThrow(/cannot be deleted/);
  });

  it('requires a failure code exactly when the transaction is rejected or failed', async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { status: 'REJECTED', processed_at: null })).rejects.toThrow(/wager_transactions_failure_code_on_failure/);
  });

  describe('ledger', () => {
    it('validates the entry arithmetic', async () => {
      const walletId = await insertWallet();
      const txId = await insertTransaction(walletId);

      await expect(insertLedger(walletId, txId, 'CREDIT', '10.00', '0.00', '11.00')).rejects.toThrow(/wallet_ledger_entries_balanced/);
      await expect(insertLedger(walletId, txId, 'DEBIT', '10.00', '0.00', '-10.00')).rejects.toThrow(/wallet_ledger_entries_balances_not_negative/);
    });

    it('keeps the entries chained by balance', async () => {
      const walletId = await insertWallet();
      const first = await insertTransaction(walletId);
      const second = await insertTransaction(walletId);

      await creditInTransaction(walletId, first);

      await expect(insertLedger(walletId, second, 'CREDIT', '5.00', '0.00', '5.00')).rejects.toThrow(/ledger chain broken/);
    });

    it('allows at most one entry per transaction and wallet', async () => {
      const walletId = await insertWallet();
      const txId = await insertTransaction(walletId);

      await creditInTransaction(walletId, txId);

      await expect(insertLedger(walletId, txId, 'CREDIT', '10.00', '10.00', '20.00')).rejects.toThrow(/wallet_ledger_entries_one_per_transaction/);
    });

    it('is append-only: no update, delete or truncate', async () => {
      await expect(sql.query('UPDATE wallet_ledger_entries SET amount = amount')).rejects.toThrow(/append-only/);
      await expect(sql.query('DELETE FROM wallet_ledger_entries')).rejects.toThrow(/append-only/);
      await expect(sql.query('TRUNCATE wallet_ledger_entries CASCADE')).rejects.toThrow(/append-only/);
    });
  });
});
