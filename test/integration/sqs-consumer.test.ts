import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { TransientInfrastructureError } from '@/application/errors/application.error';
import { SubmitWagerTransaction } from '@/application/wager/submit-wager-transaction.use-case';
import { WagerTransactionConsumer } from '@/infrastructure/messaging/wager-transaction.consumer';
import { Api, bet, resetDatabase, Sql, startApp, TestApp, TestQueues, waitFor, wagerEnvelope } from '../support/harness';

let testApp: TestApp;
let api: Api;
let sql: Sql;
let queues: TestQueues;
let consumer: WagerTransactionConsumer;
let submitWager: SubmitWagerTransaction;

async function pollUntilIdle(): Promise<void> {
  let idle = 0;

  while (idle < 2) {
    idle = (await consumer.pollOnce(1)) === 0 ? idle + 1 : 0;
  }
}

async function debitsOf(walletId: string): Promise<number> {
  const row = await sql.one<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  );
  return Number(row.count);
}

describe('SQS consumer', () => {
  beforeAll(async () => {
    await resetDatabase();
    queues = new TestQueues();
    testApp = await startApp();
    api = new Api(testApp.url);
    sql = await Sql.connect();
    consumer = testApp.app.get(WagerTransactionConsumer);
    submitWager = testApp.app.get(SubmitWagerTransaction);
  });

  beforeEach(async () => {
    await queues.reset();
  });

  afterAll(async () => {
    await testApp.close();
    await sql.close();
    queues.close();
  });

  it('settles a message through the same use case as HTTP and acks after commit', async () => {
    const wallet = await api.createWallet('100.00');
    const envelope = wagerEnvelope(bet(wallet, '25.00'));

    await queues.sendWager(envelope);
    await pollUntilIdle();

    const transaction = await api.get(`/providers/provider-a/wagering/transactions/${envelope.data.externalTransactionId}`);
    const inbox = await sql.one<{ processed: boolean }>(
      'SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id = ?',
      [envelope.messageId],
    );

    expect(transaction.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
    expect(inbox.processed).toBe(true);
    expect(await queues.drain('wager', 1_500)).toHaveLength(0);
  });

  it('deduplicates redeliveries of the same message through the persistent inbox', async () => {
    const wallet = await api.createWallet('100.00');
    const envelope = wagerEnvelope(bet(wallet, '25.00'));

    await queues.sendWager(envelope);
    await queues.sendWager(envelope);
    await queues.sendWager(envelope);
    await pollUntilIdle();

    expect(await debitsOf(wallet.id)).toBe(1);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('75.00');
  });

  it('applies the effect once when the worker dies after the commit and before the ack', async () => {
    const wallet = await api.createWallet('100.00');
    const envelope = wagerEnvelope(bet(wallet, '40.00'));
    await queues.sendWager(envelope);

    const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: await queues.queues.wager(),
      VisibilityTimeout: 2,
      WaitTimeSeconds: 2,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }));

    expect(await consumer.handle(Messages[0]!)).toBe('ack');

    await Bun.sleep(2_500);
    await pollUntilIdle();

    expect(await debitsOf(wallet.id)).toBe(1);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('60.00');
    expect((await queues.drain('wager', 1_500)).filter((message) => message.Body?.includes(wallet.id))).toHaveLength(0);
  });

  it('acks business errors such as an unknown wallet', async () => {
    await queues.sendWager(wagerEnvelope(bet({ id: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: 'ghost' }, '1.00')));
    await pollUntilIdle();

    expect(await queues.drain('wager', 1_500)).toHaveLength(0);
    expect(await queues.drain('dlq', 1_500)).toHaveLength(0);
  });

  it('sends malformed and invalid messages straight to the DLQ', async () => {
    const wallet = await api.createWallet('100.00');

    await queues.sendRaw('{ this is not json');
    await queues.sendWager(wagerEnvelope(bet(wallet, '1.001')));
    await pollUntilIdle();

    const deadLetters = await queues.drain('dlq');

    expect(deadLetters).toHaveLength(2);
    expect(deadLetters.map((message) => message.MessageAttributes?.reason?.StringValue)).toEqual(['permanent_error', 'permanent_error']);
    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('100.00');
  });

  it('retries transient failures with backoff and gives up into the DLQ after the receive limit', async () => {
    const wallet = await api.createWallet('100.00');
    const original = submitWager.execute.bind(submitWager);
    let attempts = 0;

    submitWager.execute = async () => {
      attempts += 1;
      throw new TransientInfrastructureError('database is down');
    };

    try {
      await queues.sendWager(wagerEnvelope(bet(wallet, '10.00')));

      const deadLetters = await waitFor(async () => {
        await consumer.pollOnce(1);
        const messages = await queues.drain('dlq', 1_000);
        return messages.length > 0 ? messages : undefined;
      }, 45_000);

      expect(attempts).toBe(3);
      expect(deadLetters[0]!.MessageAttributes?.reason?.StringValue).toBe('max_receive_count');
    } finally {
      submitWager.execute = original;
    }

    expect(await debitsOf(wallet.id)).toBe(0);
  });

  it('settles exactly once when a transient failure is followed by recovery', async () => {
    const wallet = await api.createWallet('100.00');
    const original = submitWager.execute.bind(submitWager);
    let failures = 0;

    submitWager.execute = async (...args) => {
      if (failures === 0) {
        failures += 1;
        throw new TransientInfrastructureError('connection reset');
      }
      return original(...args);
    };

    try {
      await queues.sendWager(wagerEnvelope(bet(wallet, '10.00')));
      await consumer.pollOnce(1);
      await waitFor(async () => {
        await consumer.pollOnce(1);
        return (await debitsOf(wallet.id)) === 1;
      }, 30_000);
    } finally {
      submitWager.execute = original;
    }

    expect((await sql.assertLedgerMatchesBalance(wallet.id)).balance).toBe('90.00');
  });

  it('on shutdown finishes the message in flight and releases the ones not started', async () => {
    const wallet = await api.createWallet('100.00');
    const original = submitWager.execute.bind(submitWager);
    let started = 0;

    submitWager.execute = async (...args) => {
      started += 1;
      await Bun.sleep(400);
      return original(...args);
    };

    try {
      for (let i = 0; i < 5; i++) {
        await queues.sendWager(wagerEnvelope(bet(wallet, '1.00')));
      }

      consumer.start();
      await waitFor(async () => started > 0, 10_000, 20);
      await consumer.stop();
    } finally {
      submitWager.execute = original;
    }

    const processed = await debitsOf(wallet.id);
    const released = (await queues.drain('wager', 3_000)).filter((message) => message.Body?.includes(wallet.id));

    expect(processed).toBeGreaterThanOrEqual(1);
    expect(processed + released.length).toBe(5);
    await sql.assertLedgerMatchesBalance(wallet.id);
  });
});
