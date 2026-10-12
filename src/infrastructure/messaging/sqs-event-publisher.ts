import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { EventPublisher, PublishFailure } from '../../application/ports/event-publisher';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { SqsQueues } from './sqs-queues';

const SQS_BATCH_LIMIT = 10;

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(private readonly queues: SqsQueues) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<PublishFailure[]> {
    const failures: PublishFailure[] = [];

    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      failures.push(...await this.publishBatch(messages.slice(start, start + SQS_BATCH_LIMIT)));
    }

    return failures;
  }

  private async publishBatch(batch: OutboxMessage[]): Promise<PublishFailure[]> {
    try {
      const result = await this.queues.client.send(new SendMessageBatchCommand({
        QueueUrl: await this.queues.events(),
        Entries: batch.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
          },
        })),
      }));

      return (result.Failed ?? []).map((failure) => ({
        messageId: batch[Number(failure.Id)]!.id,
        error: `${failure.Code}: ${failure.Message ?? 'unknown error'}`,
      }));
    } catch (error) {
      return batch.map((message) => ({ messageId: message.id, error: (error as Error).message }));
    }
  }
}
