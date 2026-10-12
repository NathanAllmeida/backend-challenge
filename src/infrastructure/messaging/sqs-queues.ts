import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { appConfig } from '../../config/app.config';

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: appConfig.sqs.region,
    endpoint: appConfig.sqs.endpoint,
  });
}

@Injectable()
export class SqsQueues implements OnModuleDestroy {
  readonly client = createSqsClient();
  private readonly urls = new Map<string, string>();

  wager(): Promise<string> {
    return this.url(appConfig.sqs.wagerQueue);
  }

  wagerDlq(): Promise<string> {
    return this.url(appConfig.sqs.wagerDlq);
  }

  events(): Promise<string> {
    return this.url(appConfig.sqs.eventsQueue);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async url(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);

    if (cached) {
      return cached;
    }

    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));

    if (!QueueUrl) {
      throw new Error(`Queue ${queueName} not found`);
    }

    this.urls.set(queueName, QueueUrl);
    return QueueUrl;
  }
}
