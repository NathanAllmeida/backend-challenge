import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors/application.error';
import { Metrics } from '../../application/ports/metrics';
import { SubmitWagerTransaction } from '../../application/wager/submit-wager-transaction.use-case';
import { appConfig } from '../../config/app.config';
import { validateContract } from '../../contracts/validate-contract';
import { WagerTransactionRequestedMessage } from '../../contracts/wager-transaction.contract';
import { DomainError } from '../../domain/errors/domain.error';
import { LogContext } from '../observability/log-context';
import { SqsQueues } from './sqs-queues';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

type Outcome = 'ack' | 'retry' | 'dead-letter';

const MAX_BACKOFF_SECONDS = 300;

@Injectable()
export class WagerTransactionConsumer {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private poll?: AbortController;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queues: SqsQueues,
    private readonly submitWager: SubmitWagerTransaction,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;
    this.loop = this.consume();
    this.logger.log({ message: 'wager consumer started', queue: appConfig.sqs.wagerQueue });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.poll?.abort();

    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    this.logger.log({ message: 'wager consumer stopped' });
  }

  async pollOnce(waitTimeSeconds = appConfig.sqs.waitTimeSeconds, visibilityTimeout = appConfig.sqs.visibilityTimeoutSeconds): Promise<number> {
    this.poll = new AbortController();

    const { Messages = [] } = await this.queues.client.send(new ReceiveMessageCommand({
      QueueUrl: await this.queues.wager(),
      MaxNumberOfMessages: appConfig.sqs.batchSize,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }), { abortSignal: this.poll.signal });

    const work = this.processByGroup(Messages);
    this.inFlight.add(work);
    await work.finally(() => this.inFlight.delete(work));

    return Messages.length;
  }

  async handle(message: Message): Promise<Outcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    try {
      const envelope = validateContract(WagerTransactionRequestedMessage, JSON.parse(message.Body ?? ''));

      return await LogContext.run({
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      }, async () => {
        const result = await this.submitWager.execute(envelope.data.toCommand(envelope.data.idempotencyKey), {
          source: 'sqs',
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
        });

        LogContext.enrich({ transactionId: result.transactionId });
        this.logger.log({ message: 'wager message settled', status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay });

        return 'ack' as const;
      });
    } catch (error) {
      return this.classify(error, receiveCount);
    }
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) {
          break;
        }

        this.logger.error({ message: 'failed to poll wager queue', error: (error as Error).message });
        await Bun.sleep(1_000);
      }
    }
  }

  private async processByGroup(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();

    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }

    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (const message of messages) {
      if (this.stopping) {
        await this.release(message);
        continue;
      }

      await this.settle(message, await this.handle(message));
    }
  }

  private async settle(message: Message, outcome: Outcome): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    if (outcome === 'ack') {
      await this.delete(message);
      return;
    }

    if (outcome === 'dead-letter') {
      await this.deadLetter(message, 'permanent_error');
      return;
    }

    if (receiveCount >= appConfig.sqs.maxReceiveCount) {
      await this.deadLetter(message, 'max_receive_count');
      return;
    }

    const backoffSeconds = Math.min(2 ** receiveCount, MAX_BACKOFF_SECONDS);
    this.metrics.retryScheduled('sqs_transient');

    await this.queues.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: await this.queues.wager(),
      ReceiptHandle: message.ReceiptHandle!,
      VisibilityTimeout: backoffSeconds,
    }));
  }

  private classify(error: unknown, receiveCount: number): Outcome {
    if (error instanceof SyntaxError || error instanceof InvalidRequestError || error instanceof IdempotencyConflictError) {
      this.logger.error({ message: 'wager message is permanently invalid', code: errorCode(error), error: (error as Error).message });
      return 'dead-letter';
    }

    if (error instanceof WalletNotFoundError || error instanceof DuplicateExternalTransactionError || error instanceof DomainError) {
      this.logger.warn({ message: 'wager message rejected by business rule', code: errorCode(error), error: error.message });
      return 'ack';
    }

    if (error instanceof TransientInfrastructureError) {
      this.logger.warn({ message: 'transient failure, message will be retried', reason: error.reason, receiveCount });
      return 'retry';
    }

    this.logger.error({ message: 'unexpected failure handling wager message', error: (error as Error).message, receiveCount });
    return 'retry';
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    await this.queues.client.send(new SendMessageCommand({
      QueueUrl: await this.queues.wagerDlq(),
      MessageBody: message.Body ?? '',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
      MessageDeduplicationId: message.MessageId,
      MessageAttributes: {
        reason: { DataType: 'String', StringValue: reason },
      },
    }));

    await this.delete(message);
    this.metrics.sentToDlq(reason);
    this.logger.error({ message: 'wager message moved to DLQ', sqsMessageId: message.MessageId, reason });
  }

  private async delete(message: Message): Promise<void> {
    await this.queues.client.send(new DeleteMessageCommand({
      QueueUrl: await this.queues.wager(),
      ReceiptHandle: message.ReceiptHandle!,
    }));
  }

  private async release(message: Message): Promise<void> {
    await this.queues.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: await this.queues.wager(),
      ReceiptHandle: message.ReceiptHandle!,
      VisibilityTimeout: 0,
    }));
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof DomainError) {
    return error.code;
  }

  return error instanceof SyntaxError ? 'MALFORMED_JSON' : 'UNKNOWN';
}
