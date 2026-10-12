import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ResolvePendingReferences } from '@/application/wager/resolve-pending-references.use-case';
import { Api, bet, resetDatabase, Sql, startApp, TestApp, TestQueues } from '../support/harness';

let testApp: TestApp;
let api: Api;
let sql: Sql;
let queues: TestQueues;

async function countEntries(walletId: string, direction: 'DEBIT' | 'CREDIT'): Promise<number> {
  const row = await sql.one<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?',
    [walletId, direction],
  );
  return Number(row.count);
}

describe('concurrency on a single instance with real parallelism', () => {
  beforeAll(async () => {
    await resetDatabase();
    queues = new TestQueues();
    await queues.reset();
    testApp = await startApp();
    api = new Api(testApp.url);
    sql = await Sql.connect();
  });

  afterAll(async () => {
    await testApp.close();
    await sql.close();
    queues.close();
  });

  it('the same BET sent 50 times in parallel produces a single debit', async () => {
    const wallet = await api.createWallet('100.00');
    const payload = bet(wallet, '10.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => api.wager(payload)));

    const transactionIds = new Set(responses.map((response) => response.body.transactionId));
    const originals = responses.filter((response) => response.body.idempotentReplay === false);

    expect(responses.every((response) => [200, 201].includes(response.status))).toBe(true);
    expect(transactionIds.size).toBe(1);
    expect(originals).toHaveLength(1);
    expect(responses.every((response) => response.body.balance.amount === '90.00')).toBe(true);
    expect(await countEntries(wallet.id, 'DEBIT')).toBe(1);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('90.00');
  });

  it('two bets of 80.00 over 100.00 at the same time: one PROCESSED, one REJECTED, balance 20.00', async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await api.createWallet('100.00');

      const results = await Promise.all([api.wager(bet(wallet, '80.00')), api.wager(bet(wallet, '80.00'))]);
      const statuses = results.map((result) => result.body.status).sort();
      const rejected = results.find((result) => result.body.status === 'REJECTED');

      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await countEntries(wallet.id, 'DEBIT')).toBe(1);
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('20.00');
    }
  });

  it('retries of the contended bets never duplicate the debit', async () => {
    const wallet = await api.createWallet('100.00');
    const first = bet(wallet, '80.00');
    const second = bet(wallet, '80.00');

    await Promise.all([api.wager(first), api.wager(second)]);
    await Promise.all(Array.from({ length: 20 }, (_, index) => api.wager(index % 2 === 0 ? first : second)));

    expect(await countEntries(wallet.id, 'DEBIT')).toBe(1);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('20.00');
  });

  it('a hot wallet under mixed concurrent BETs and WINs stays consistent', async () => {
    const wallet = await api.createWallet('50.00');

    const operations = Array.from({ length: 120 }, (_, index) =>
      index % 3 === 0 ? bet(wallet, '0.50', { kind: 'WIN' }) : bet(wallet, '1.00'));
    const results = await Promise.all(operations.map((operation) => api.wager(operation)));

    const processedBets = results.filter((result, index) => operations[index]!.kind === 'BET' && result.body.status === 'PROCESSED').length;
    const wins = operations.filter((operation) => operation.kind === 'WIN').length;
    const expected = (5000 - processedBets * 100 + wins * 50) / 100;

    const check = await sql.assertLedgerMatchesBalance(wallet.id);
    expect(Number(check.balance)).toBe(expected);
    expect(results.every((result) => ['PROCESSED', 'REJECTED'].includes(result.body.status))).toBe(true);
  });

  it('different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => api.createWallet('100.00')));

    const startedAt = performance.now();
    await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 8 }, () => api.wager(bet(wallet, '10.00')))));
    const elapsedMs = performance.now() - startedAt;

    for (const wallet of wallets) {
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('20.00');
    }

    expect(elapsedMs).toBeLessThan(30_000);
  });

  it('ROLLBACK and REFUND racing with their BET always end up settled exactly once', async () => {
    const wallet = await api.createWallet('100.00');
    const rounds = Array.from({ length: 15 }, (_, index) => {
      const betPayload = bet(wallet, '5.00');
      const reversal = bet(wallet, '5.00', {
        kind: index % 2 === 0 ? 'ROLLBACK' : 'REFUND',
        roundId: betPayload.roundId,
        referenceExternalTransactionId: betPayload.externalTransactionId,
      });
      return { betPayload, reversal };
    });

    await Promise.all(rounds.flatMap(({ betPayload, reversal }) => [api.wager(reversal), api.wager(betPayload)]));

    const resolver = testApp.app.get(ResolvePendingReferences);
    for (let attempt = 0; attempt < 10; attempt++) {
      await sql.query(`UPDATE wager_transactions SET next_reference_check_at = now() - interval '1 second' WHERE status = 'PENDING_REFERENCE'`);
      if (await resolver.execute() === 0) {
        break;
      }
    }

    const statuses = await sql.query<{ status: string }>(
      `SELECT status FROM wager_transactions WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK')`,
      [wallet.id],
    );

    expect(statuses.every((row) => row.status === 'PROCESSED')).toBe(true);
    expect(await countEntries(wallet.id, 'CREDIT')).toBe(1 + rounds.length);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('100.00');
  });
});
