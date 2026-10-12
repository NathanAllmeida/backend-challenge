import {
  DeleteMessageCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '@/app.module';
import { appConfig } from '@/config/app.config';
import { databaseConfig } from '@/infrastructure/database/mikro-orm.config';
import { setupQueues } from '@/infrastructure/messaging/setup-queues';
import { createSqsClient, SqsQueues } from '@/infrastructure/messaging/sqs-queues';

export interface TestApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    app,
    url: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

export async function resetDatabase(): Promise<void> {
  const orm = await MikroORM.init(databaseConfig({ poolMax: 2 }));

  try {
    await orm.em.getConnection().execute('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export class Sql {
  private constructor(private readonly orm: MikroORM) {}

  static async connect(): Promise<Sql> {
    return new Sql(await MikroORM.init(databaseConfig({ poolMax: 4 })));
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.orm.em.getConnection().execute(sql, params);
  }

  transaction(work: (run: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>): Promise<void> {
    return this.orm.em.fork().transactional((em) => work((query, params = []) => em.execute(query, params)));
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await this.query<T>(sql, params);
    return row!;
  }

  async assertLedgerMatchesBalance(walletId: string): Promise<{ balance: string; ledger: string; entries: number }> {
    const row = await this.one<{ balance: string; ledger: string; entries: string; last_after: string | null }>(
      `SELECT w.balance::text AS balance,
              (COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)
               - COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0))::text AS ledger,
              COUNT(e.id)::text AS entries,
              (SELECT balance_after::text FROM wallet_ledger_entries WHERE wallet_id = w.id ORDER BY position DESC LIMIT 1) AS last_after
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );

    if (row.balance !== row.ledger || (row.last_after !== null && row.last_after !== row.balance)) {
      throw new Error(`Wallet ${walletId} diverges from ledger: balance=${row.balance} ledger=${row.ledger} last=${row.last_after}`);
    }

    return { balance: row.balance, ledger: row.ledger, entries: Number(row.entries) };
  }

  async assertEveryWalletMatchesLedger(): Promise<number> {
    const wallets = await this.query<{ id: string }>('SELECT id FROM wallets');

    for (const wallet of wallets) {
      await this.assertLedgerMatchesBalance(wallet.id);
    }

    return wallets.length;
  }

  close(): Promise<void> {
    return this.orm.close(true);
  }
}

export class TestQueues {
  readonly client: SQSClient = createSqsClient();
  readonly queues = new SqsQueues();

  async reset(): Promise<void> {
    await setupQueues(this.client);

    for (const url of [await this.queues.wager(), await this.queues.wagerDlq(), await this.queues.events()]) {
      await this.client.send(new PurgeQueueCommand({ QueueUrl: url }));
    }
  }

  async sendWager(envelope: WagerEnvelope, deduplicationId = uuidv7()): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: await this.queues.wager(),
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data?.walletId ?? 'malformed',
      MessageDeduplicationId: deduplicationId,
    }));
  }

  async sendRaw(body: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: await this.queues.wager(),
      MessageBody: body,
      MessageGroupId: 'raw',
      MessageDeduplicationId: uuidv7(),
    }));
  }

  async drain(queue: 'wager' | 'dlq' | 'events', maxWaitMs = 3_000): Promise<Message[]> {
    const url = queue === 'wager' ? await this.queues.wager() : queue === 'dlq' ? await this.queues.wagerDlq() : await this.queues.events();
    const messages: Message[] = [];
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const { Messages = [] } = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
      }));

      for (const message of Messages) {
        messages.push(message);
        await this.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
      }

      if (Messages.length === 0 && messages.length > 0) {
        break;
      }
    }

    return messages;
  }

  close(): void {
    this.client.destroy();
    this.queues.onModuleDestroy();
  }
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface WagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerPayload & { idempotencyKey: string };
}

export function wagerEnvelope(payload: WagerPayload, messageId = `msg-${uuidv7()}`): WagerEnvelope {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
  };
}

export class Api {
  constructor(private readonly baseUrl: string) {}

  async createWallet(amount = '100.00', playerId = `player-${uuidv7()}`, currency = 'BRL'): Promise<{ id: string; playerId: string }> {
    const response = await this.post('/wallets', { playerId, initialBalance: { amount, currency } });

    if (response.status !== 201) {
      throw new Error(`Could not create wallet: ${response.status} ${JSON.stringify(response.body)}`);
    }

    return response.body as { id: string; playerId: string };
  }

  wager(payload: WagerPayload, idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`) {
    return this.post('/wagering/transactions', payload, { 'Idempotency-Key': idempotencyKey });
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  async get(path: string) {
    const response = await fetch(`${this.baseUrl}${path}`);
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
}

export function bet(wallet: { id: string; playerId: string }, amount: string, overrides: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuidv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${uuidv7()}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();

    if (value) {
      return value;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export { appConfig };
