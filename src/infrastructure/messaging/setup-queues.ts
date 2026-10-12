import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { appConfig } from '../../config/app.config';
import { createSqsClient } from './sqs-queues';

const client = createSqsClient();
const { sqs } = appConfig;

async function createFifoQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
  const { QueueUrl } = await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(sqs.visibilityTimeoutSeconds),
      MessageRetentionPeriod: '1209600',
      ...attributes,
    },
  }));

  return QueueUrl!;
}

const dlqUrl = await createFifoQueue(sqs.wagerDlq);
const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));

await createFifoQueue(sqs.wagerQueue, {
  RedrivePolicy: JSON.stringify({
    deadLetterTargetArn: Attributes!.QueueArn,
    maxReceiveCount: String(sqs.maxReceiveCount),
  }),
});
await createFifoQueue(sqs.eventsQueue);

console.log(JSON.stringify({ level: 'info', message: 'queues ready', queues: [sqs.wagerQueue, sqs.wagerDlq, sqs.eventsQueue] }));
client.destroy();
