import 'reflect-metadata';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { SqsQueues } from '@/infrastructure/messaging/sqs-queues';
import { WagerTransactionConsumer } from '@/infrastructure/messaging/wager-transaction.consumer';

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const queues = app.get(SqsQueues);

const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({
  QueueUrl: await queues.wager(),
  MaxNumberOfMessages: 1,
  WaitTimeSeconds: 5,
  VisibilityTimeout: 3,
  MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
}));

if (Messages.length !== 1) {
  process.exit(2);
}

const outcome = await app.get(WagerTransactionConsumer).handle(Messages[0]!);

console.log(JSON.stringify({ committed: outcome === 'ack' }));
process.exit(outcome === 'ack' ? 137 : 3);
