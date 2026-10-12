import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { appConfig } from '../../config/app.config';
import { createSqsClient } from './sqs-queues';

export async function setupQueues(client: SQSClient = createSqsClient()): Promise<void> {
  const { sqs } = appConfig;

  const createFifoQueue = async (name: string, attributes: Record<string, string> = {}): Promise<string> => {
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
  };

  const dlqUrl = await createFifoQueue(sqs.wagerDlq);
  const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));

  await createFifoQueue(sqs.wagerQueue, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes!.QueueArn,
      maxReceiveCount: String(sqs.maxReceiveCount),
    }),
  });
  await createFifoQueue(sqs.eventsQueue);
}

if (import.meta.main) {
  const client = createSqsClient();
  await setupQueues(client);
  client.destroy();

  const { sqs } = appConfig;
  console.log(JSON.stringify({ level: 'info', message: 'queues ready', queues: [sqs.wagerQueue, sqs.wagerDlq, sqs.eventsQueue] }));
}
