import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { OutboxRepository } from '@/application/ports/repositories';
import { ResolvePendingReferences } from '@/application/wager/resolve-pending-references.use-case';
import { ReferenceRetryPolicy } from '@/domain/wager/reference-retry-policy';
import { Api, bet, resetDatabase, Sql, startApp, TestApp, TestQueues } from '../support/harness';

let testApp: TestApp;
let api: Api;
let sql: Sql;
let queues: TestQueues;

describe('wagering API', () => {
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

  describe('wallets', () => {
    it('opens a wallet with an OPENING credit in the same transaction', async () => {
      const wallet = await api.createWallet('1000.00');
      const ledger = await api.get(`/wallets/${wallet.id}/ledger`);
      const opening = await sql.one<{ kind: string; status: string }>(
        `SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`,
        [wallet.id],
      );

      expect(wallet).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
      expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.items[0]).toMatchObject({ direction: 'CREDIT', balanceAfter: { amount: '1000.00' } });
    });

    it('opens a zero balance wallet without ledger entries', async () => {
      const wallet = await api.createWallet('0.00');
      const ledger = await api.get(`/wallets/${wallet.id}/ledger`);

      expect(ledger.body.items).toHaveLength(0);
    });

    it('rejects a second wallet for the same player and currency with 409', async () => {
      const wallet = await api.createWallet('10.00');
      const duplicate = await api.post('/wallets', { playerId: wallet.playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
      const otherCurrency = await api.post('/wallets', { playerId: wallet.playerId, initialBalance: { amount: '5.00', currency: 'USD' } });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
      expect(otherCurrency.status).toBe(201);
    });

    it('validates the payload with 400', async () => {
      const invalid = await api.post('/wallets', { playerId: 'p', initialBalance: { amount: '10.001', currency: 'BRL' } });
      const negative = await api.post('/wallets', { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } });
      const missing = await api.post('/wallets', { playerId: 'p' });

      expect([invalid.status, negative.status, missing.status]).toEqual([400, 400, 400]);
      expect(invalid.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 for an unknown wallet', async () => {
      const response = await api.get('/wallets/0192f291-27dd-7d3f-8071-5f8685deef37');
      expect(response.status).toBe(404);
    });

    it('paginates the ledger with an opaque and stable cursor', async () => {
      const wallet = await api.createWallet('100.00');

      for (let i = 0; i < 4; i++) {
        await api.wager(bet(wallet, '1.00'));
      }

      const first = await api.get(`/wallets/${wallet.id}/ledger?limit=2`);
      const second = await api.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
      const third = await api.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`);
      const invalidCursor = await api.get(`/wallets/${wallet.id}/ledger?cursor=nope`);

      expect(first.body.items.map((item: any) => item.balanceAfter.amount)).toEqual(['100.00', '99.00']);
      expect(second.body.items.map((item: any) => item.balanceAfter.amount)).toEqual(['98.00', '97.00']);
      expect(third.body.items.map((item: any) => item.balanceAfter.amount)).toEqual(['96.00']);
      expect(third.body.nextCursor).toBeNull();
      expect(invalidCursor.status).toBe(400);
    });
  });

  describe('submitting transactions', () => {
    it('processes a BET and replays it with the original result', async () => {
      const wallet = await api.createWallet('1000.00');
      const payload = bet(wallet, '25.00');

      const first = await api.wager(payload);
      await api.wager(bet(wallet, '100.00'));
      const replay = await api.wager(payload);

      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('treats the same idempotency key with another payload as a conflict', async () => {
      const wallet = await api.createWallet('100.00');
      const payload = bet(wallet, '10.00');

      await api.wager(payload);
      const conflict = await api.wager({ ...payload, money: { amount: '11.00', currency: 'BRL' } });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('90.00');
    });

    it('treats equivalent amounts ("10" and "10.00") as the same payload', async () => {
      const wallet = await api.createWallet('100.00');
      const payload = bet(wallet, '10');

      await api.wager(payload);
      const replay = await api.wager({ ...payload, money: { amount: '10.00', currency: 'BRL' } });

      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    it('rejects the same external id under a different idempotency key', async () => {
      const wallet = await api.createWallet('100.00');
      const payload = bet(wallet, '10.00');

      await api.wager(payload);
      const response = await api.wager(payload, 'another-key');

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DUPLICATE_EXTERNAL_TRANSACTION');
    });

    it('requires the Idempotency-Key header and a valid payload', async () => {
      const wallet = await api.createWallet('100.00');

      const missingKey = await api.post('/wagering/transactions', bet(wallet, '1.00'));
      const opening = await api.wager(bet(wallet, '1.00', { kind: 'OPENING' }));
      const scientific = await api.wager(bet(wallet, '1e2'));
      const refundWithoutReference = await api.wager(bet(wallet, '1.00', { kind: 'REFUND' }));

      expect(missingKey.status).toBe(400);
      expect(opening.status).toBe(400);
      expect(scientific.status).toBe(400);
      expect(refundWithoutReference.status).toBe(400);
    });

    it('answers 422 for business rejections and keeps them auditable', async () => {
      const wallet = await api.createWallet('10.00');
      const rejected = await api.wager(bet(wallet, '10.01'));
      const stored = await api.get(`/wagering/transactions/${rejected.body.transactionId}`);

      expect(rejected.status).toBe(422);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
      expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).entries).toBe(1);
    });

    it('answers 422 when the wallet does not exist', async () => {
      const response = await api.wager(bet({ id: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: 'p' }, '1.00'));

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it('rejects a currency that differs from the wallet currency', async () => {
      const wallet = await api.createWallet('100.00');
      const response = await api.wager(bet(wallet, '1.00', { money: { amount: '1.00', currency: 'USD' } }));

      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('runs a full round: BET, WIN, LOSS, REFUND and ROLLBACK', async () => {
      const wallet = await api.createWallet('100.00');
      const roundId = 'round-full';

      const firstBet = bet(wallet, '30.00', { roundId });
      const win = bet(wallet, '50.00', { roundId, kind: 'WIN', referenceExternalTransactionId: firstBet.externalTransactionId });
      const loss = bet(wallet, '0.00', { roundId, kind: 'LOSS' });
      const secondBet = bet(wallet, '20.00', { roundId });
      const refund = bet(wallet, '20.00', { roundId, kind: 'REFUND', referenceExternalTransactionId: secondBet.externalTransactionId });
      const rollbackWin = bet(wallet, '50.00', { roundId, kind: 'ROLLBACK', referenceExternalTransactionId: win.externalTransactionId });
      const secondRefund = bet(wallet, '20.00', { roundId, kind: 'REFUND', referenceExternalTransactionId: secondBet.externalTransactionId });
      const rollbackRefundedBet = bet(wallet, '20.00', { roundId, kind: 'ROLLBACK', referenceExternalTransactionId: secondBet.externalTransactionId });

      const results = [];
      for (const payload of [firstBet, win, loss, secondBet, refund, rollbackWin, secondRefund, rollbackRefundedBet]) {
        results.push(await api.wager(payload));
      }

      expect(results.map((result) => result.body.status)).toEqual([
        'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'REJECTED', 'REJECTED',
      ]);
      expect(results.map((result) => result.body.balance.amount)).toEqual([
        '70.00', '120.00', '120.00', '100.00', '120.00', '70.00', '70.00', '70.00',
      ]);
      expect(results[6]!.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(results[7]!.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

      const check = await sql.assertLedgerMatchesBalance(wallet.id);
      expect(check).toEqual({ balance: '70.00', ledger: '70.00', entries: 6 });
    });

    it('rejects a reversal that would leave the balance negative with its own failure code', async () => {
      const wallet = await api.createWallet('0.00');
      const win = bet(wallet, '50.00', { kind: 'WIN' });

      await api.wager(win);
      await api.wager(bet(wallet, '45.00'));
      const rollback = await api.wager(bet(wallet, '50.00', { kind: 'ROLLBACK', roundId: win.roundId, referenceExternalTransactionId: win.externalTransactionId }));

      expect(rollback.status).toBe(422);
      expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('5.00');
    });

    it('finds transactions by id and by provider external id', async () => {
      const wallet = await api.createWallet('100.00');
      const payload = bet(wallet, '5.00');
      const created = await api.wager(payload);

      const byId = await api.get(`/wagering/transactions/${created.body.transactionId}`);
      const byExternal = await api.get(`/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
      const missing = await api.get('/providers/provider-a/wagering/transactions/nope');

      expect(byId.body).toMatchObject({ id: created.body.transactionId, kind: 'BET', money: { amount: '5.00' } });
      expect(byExternal.body.id).toBe(created.body.transactionId);
      expect(missing.status).toBe(404);
    });
  });

  describe('out of order references', () => {
    it('keeps a ROLLBACK as PENDING_REFERENCE until the BET arrives, then settles it', async () => {
      const wallet = await api.createWallet('100.00');
      const betPayload = bet(wallet, '40.00');
      const rollback = bet(wallet, '40.00', { kind: 'ROLLBACK', roundId: betPayload.roundId, referenceExternalTransactionId: betPayload.externalTransactionId });

      const early = await api.wager(rollback);
      expect(early.status).toBe(202);
      expect(early.body.status).toBe('PENDING_REFERENCE');

      await api.wager(betPayload);
      await sql.query(`UPDATE wager_transactions SET next_reference_check_at = now() - interval '1 second' WHERE id = ?`, [early.body.transactionId]);
      await testApp.app.get(ResolvePendingReferences).execute();

      const settled = await api.get(`/wagering/transactions/${early.body.transactionId}`);
      const replay = await api.wager(rollback);

      expect(settled.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('100.00');
    });

    it('gives up with REFERENCE_NOT_FOUND after the retry budget and publishes the rejection', async () => {
      const wallet = await api.createWallet('100.00');
      const refund = bet(wallet, '10.00', { kind: 'REFUND', referenceExternalTransactionId: 'never-arrives' });
      const pending = await api.wager(refund);

      await sql.query(
        `UPDATE wager_transactions SET reference_attempts = ?, next_reference_check_at = now() - interval '1 second' WHERE id = ?`,
        [ReferenceRetryPolicy.MAX_ATTEMPTS - 1, pending.body.transactionId],
      );
      await testApp.app.get(ResolvePendingReferences).execute();

      const rejected = await api.get(`/wagering/transactions/${pending.body.transactionId}`);
      const events = await sql.query<{ event_type: string }>(
        'SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at',
        [pending.body.transactionId],
      );

      expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
      expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    });
  });

  describe('atomicity', () => {
    it('rolls back wallet, transaction, ledger and outbox together when any write fails', async () => {
      const wallet = await api.createWallet('100.00');
      const outbox = testApp.app.get(OutboxRepository);
      const originalAdd = outbox.add.bind(outbox);

      outbox.add = async () => {
        throw new Error('outbox is down');
      };

      try {
        const response = await api.wager(bet(wallet, '10.00'));
        expect(response.status).toBe(500);
      } finally {
        outbox.add = originalAdd;
      }

      const counts = await sql.one<{ transactions: string; entries: string; events: string }>(
        `SELECT (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET')::text AS transactions,
                (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS entries,
                (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS events`,
        [wallet.id, wallet.id, wallet.id],
      );

      expect(counts).toEqual({ transactions: '0', entries: '1', events: '1' });
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('100.00');
      expect((await api.get(`/wallets/${wallet.id}`)).body.version).toBe(1);
    });
  });

  describe('reconciliation and health', () => {
    it('reports a consistent wallet', async () => {
      const wallet = await api.createWallet('100.00');
      await api.wager(bet(wallet, '33.33'));

      const report = await api.post(`/wallets/${wallet.id}/reconciliation`, {});

      expect(report.status).toBe(200);
      expect(report.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '66.67', currency: 'BRL' },
        calculatedBalance: { amount: '66.67', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });

    it('exposes liveness, readiness and metrics without authentication', async () => {
      const live = await api.get('/health/live');
      const ready = await api.get('/health/ready');
      const metrics = await fetch(`${testApp.url}/metrics`).then((response) => response.text());

      expect(live.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready', checks: { database: 'up', sqs: 'up' } });
      expect(metrics).toContain('wager_transactions_total');
      expect(metrics).toContain('wager_duplicates_total');
    });
  });
});
