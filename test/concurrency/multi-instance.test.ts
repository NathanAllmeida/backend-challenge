import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Api, bet, resetDatabase, Sql, TestQueues, waitFor, wagerEnvelope } from '../support/harness';
import { AppInstance, runCrashAfterCommit } from '../support/instances';

let sql: Sql;
let queues: TestQueues;

const instances = [new AppInstance('app-1', 4101), new AppInstance('app-2', 4102), new AppInstance('app-3', 4103)];
const apis = instances.map((instance) => new Api(instance.url));

async function count(query: string, params: unknown[] = []): Promise<number> {
  const row = await sql.one<{ count: string }>(query, params);
  return Number(row.count);
}

async function countInbox(messageIds: string[]): Promise<number> {
  return count(
    `SELECT COUNT(*)::text AS count FROM inbox_messages WHERE message_id IN (${messageIds.map(() => '?').join(', ')})`,
    messageIds,
  );
}

async function inboxDuplicatesDetected(): Promise<number> {
  const bodies = await Promise.all(instances.map((instance) => fetch(`${instance.url}/metrics`).then((response) => response.text())));

  return bodies
    .flatMap((body) => body.split('\n'))
    .filter((line) => line.startsWith('wager_duplicates_total{') && line.includes('layer="inbox"'))
    .reduce((total, line) => total + Number(line.split(' ').at(-1)), 0);
}

async function waitUntilSettled(): Promise<void> {
  await waitFor(async () => {
    const unsettled = await count(`SELECT COUNT(*)::text AS count FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')`);
    const unpublished = await count('SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL');
    return unsettled === 0 && unpublished === 0;
  }, 60_000, 500);
}

describe('three application instances running at the same time', () => {
  beforeAll(async () => {
    await resetDatabase();
    queues = new TestQueues();
    await queues.reset();
    sql = await Sql.connect();
  });

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.kill()));
    await sql.close();
    queues.close();
  });

  it('applies the effect once when a worker process dies after the commit and before the ack', async () => {
    const setup = new AppInstance('setup', 4100);
    await setup.start();
    const wallet = await new Api(setup.url).createWallet('100.00');
    await setup.kill();

    const envelope = wagerEnvelope(bet(wallet, '30.00'));
    await queues.sendWager(envelope);

    const crash = await runCrashAfterCommit();
    expect(crash.exitCode).toBe(137);
    expect(crash.output).toContain('"committed":true');

    const committed = await sql.one<{ status: string }>(
      'SELECT status FROM wager_transactions WHERE external_transaction_id = ?',
      [envelope.data.externalTransactionId],
    );
    expect(committed.status).toBe('PROCESSED');

    await Promise.all(instances.map((instance) => instance.start()));

    await waitFor(async () => (await inboxDuplicatesDetected()) >= 1 && (await queues.depth()) === 0, 30_000, 500);

    expect(await count(`SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('70.00');
  });

  it('HTTP requests for the same wallet spread across instances never lose updates or duplicate debits', async () => {
    const wallet = await apis[0]!.createWallet('100.00');
    const payloads = Array.from({ length: 60 }, () => bet(wallet, '1.00'));

    const responses = await Promise.all(payloads.flatMap((payload, index) => [
      apis[index % 3]!.wager(payload),
      apis[(index + 1) % 3]!.wager(payload),
    ]));

    expect(responses.every((response) => [200, 201].includes(response.status))).toBe(true);
    expect(await count(`SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(60);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('40.00');
  });

  it('the contended 80.00 + 80.00 scenario holds across instances', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await apis[round % 3]!.createWallet('100.00');
      const results = await Promise.all([apis[0]!.wager(bet(wallet, '80.00')), apis[1]!.wager(bet(wallet, '80.00')), apis[2]!.wager(bet(wallet, '80.00'))]);

      expect(results.filter((result) => result.body.status === 'PROCESSED')).toHaveLength(1);
      expect(results.filter((result) => result.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(2);
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('20.00');
    }
  });

  it('three consumers share the queue, deduplicate redeliveries and keep every wallet consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, (_, index) => apis[index % 3]!.createWallet('100.00')));
    const envelopes = wallets.flatMap((wallet) => Array.from({ length: 12 }, () => wagerEnvelope(bet(wallet, '5.00'))));

    await Promise.all(envelopes.map((envelope) => queues.sendWager(envelope)));
    await Promise.all(envelopes.slice(0, 20).map((envelope) => queues.sendWager(envelope)));

    await waitFor(async () => (await countInbox(envelopes.map((envelope) => envelope.messageId))) === envelopes.length, 60_000, 500);
    await waitFor(async () => (await queues.depth()) === 0, 60_000, 500);
    await waitUntilSettled();

    for (const wallet of wallets) {
      expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('40.00');
    }
  });

  it('survives an instance being killed mid-load and restarted, ending consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => apis[0]!.createWallet('500.00')));
    const victim = instances[1]!;

    const load = Promise.allSettled(wallets.flatMap((wallet) => Array.from({ length: 20 }, (_, index) =>
      apis[index % 3]!.wager(bet(wallet, '1.00')))));
    const queued = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => wagerEnvelope(bet(wallet, '2.00'))));
    await Promise.all(queued.map((envelope) => queues.sendWager(envelope)));

    await Bun.sleep(300);
    await victim.kill();
    await load;
    await victim.start();

    await waitFor(async () => (await countInbox(queued.map((envelope) => envelope.messageId))) === queued.length, 90_000, 500);
    await waitUntilSettled();

    expect(await sql.assertEveryWalletMatchesLedger()).toBeGreaterThan(0);

    for (const wallet of wallets) {
      const report = await apis[2]!.post(`/wallets/${wallet.id}/reconciliation`, {});
      expect(report.body.consistent).toBe(true);
    }
  });

  it('every committed event is published by the three concurrent outbox publishers', async () => {
    await waitUntilSettled();

    const events = await count('SELECT COUNT(*)::text AS count FROM outbox_messages');
    const published = await queues.drain('events', 10_000);
    const uniqueIds = new Set(published.map((message) => JSON.parse(message.Body!).eventId));

    expect(uniqueIds.size).toBe(published.length);
    expect(published.length).toBe(events);
  });
});
