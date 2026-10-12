import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PublishOutboxEvents } from '@/application/outbox/publish-outbox-events.use-case';
import { EventPublisher } from '@/application/ports/event-publisher';
import { OutboxRepository } from '@/application/ports/repositories';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Api, resetDatabase, Sql, startApp, TestApp, TestQueues } from '../support/harness';

let first: TestApp;
let second: TestApp;
let sql: Sql;
let queues: TestQueues;

async function pendingEvents(): Promise<number> {
  const row = await sql.one<{ count: string }>('SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL');
  return Number(row.count);
}

async function publishEverything(app: TestApp): Promise<void> {
  while (await app.app.get(PublishOutboxEvents).execute() > 0) {
    continue;
  }
}

function recordPublishedIds(app: TestApp): string[] {
  const publisher = app.app.get(EventPublisher);
  const original = publisher.publish.bind(publisher);
  const ids: string[] = [];

  publisher.publish = async (messages: OutboxMessage[]) => {
    ids.push(...messages.map((message) => message.id));
    await Bun.sleep(20);
    return original(messages);
  };

  return ids;
}

describe('transactional outbox', () => {
  beforeAll(async () => {
    await resetDatabase();
    queues = new TestQueues();
    first = await startApp();
    second = await startApp();
    sql = await Sql.connect();
  });

  beforeEach(async () => {
    await queues.reset();
    await publishEverything(first);
    await queues.drain('events', 1_000);
  });

  afterAll(async () => {
    await first.close();
    await second.close();
    await sql.close();
    queues.close();
  });

  it('publishes committed events with the envelope and marks them as published', async () => {
    const wallet = await new Api(first.url).createWallet('50.00');

    expect(await pendingEvents()).toBe(2);
    await publishEverything(first);

    const messages = await queues.drain('events');
    const envelopes = messages.map((message) => JSON.parse(message.Body!));
    const balanceChanged = envelopes.find((envelope) => envelope.eventType === 'WalletBalanceChanged');

    expect(await pendingEvents()).toBe(0);
    expect(envelopes.map((envelope) => envelope.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(balanceChanged).toMatchObject({
      aggregateId: wallet.id,
      version: 1,
      data: { walletId: wallet.id, direction: 'CREDIT', balanceAfter: { amount: '50.00', currency: 'BRL' }, walletVersion: 1 },
    });
    expect(balanceChanged.eventId).toBeString();
    expect(balanceChanged.correlationId).toBeString();
  });

  it('lets two publishers drain the same outbox without claiming the same event twice', async () => {
    const api = new Api(first.url);

    for (let i = 0; i < 30; i++) {
      await api.createWallet('10.00');
    }

    const firstIds = recordPublishedIds(first);
    const secondIds = recordPublishedIds(second);

    await Promise.all([publishEverything(first), publishEverything(second)]);

    const all = [...firstIds, ...secondIds];
    const published = await queues.drain('events', 5_000);

    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect(firstIds.length).toBeGreaterThan(0);
    expect(secondIds.length).toBeGreaterThan(0);
    expect(published).toHaveLength(60);
    expect(await pendingEvents()).toBe(0);
  });

  it('publishes events committed by an instance that died before publishing', async () => {
    const doomed = await startApp();
    await new Api(doomed.url).createWallet('20.00');
    await doomed.close();

    expect(await pendingEvents()).toBe(2);

    const restarted = await startApp();
    try {
      await publishEverything(restarted);
    } finally {
      await restarted.close();
    }

    expect(await pendingEvents()).toBe(0);
    expect(await queues.drain('events')).toHaveLength(2);
  });

  it('takes over an event whose lease expired after a publisher crashed mid-flight', async () => {
    await new Api(first.url).createWallet('20.00');
    await sql.query(`UPDATE outbox_messages SET locked_until = now() + interval '1 hour' WHERE published_at IS NULL`);

    expect(await first.app.get(PublishOutboxEvents).execute()).toBe(0);

    await sql.query(`UPDATE outbox_messages SET locked_until = now() - interval '1 second' WHERE published_at IS NULL`);
    await publishEverything(second);

    expect(await pendingEvents()).toBe(0);
  });

  it('schedules a retry with backoff when the broker is unavailable', async () => {
    await new Api(first.url).createWallet('20.00');
    const publisher = first.app.get(EventPublisher);
    const original = publisher.publish.bind(publisher);

    publisher.publish = async (messages) => messages.map((message) => ({ messageId: message.id, error: 'broker unavailable' }));

    try {
      await first.app.get(PublishOutboxEvents).execute();
      expect(await first.app.get(PublishOutboxEvents).execute()).toBe(0);
    } finally {
      publisher.publish = original;
    }

    const rows = await sql.query<{ attempts: number; due_later: boolean; last_error: string }>(
      `SELECT attempts, next_attempt_at > now() AS due_later, last_error FROM outbox_messages WHERE published_at IS NULL`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.attempts === 1 && row.due_later && row.last_error === 'broker unavailable')).toBe(true);

    await sql.query('UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL');
    await publishEverything(first);
    expect(await pendingEvents()).toBe(0);
  });

  it('keeps a duplicated publication harmless: same event id, deduplicated by the broker', async () => {
    await new Api(first.url).createWallet('20.00');
    const [message] = await first.app.get(OutboxRepository).claimDue(new Date(), 1, 30_000);
    const publisher = first.app.get(EventPublisher);

    await publisher.publish([message!]);
    await publisher.publish([message!]);

    const received = await queues.drain('events');

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.Body!).eventId).toBe(message!.id);
  });
});
