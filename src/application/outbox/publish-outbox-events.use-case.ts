import { Injectable, Logger } from '@nestjs/common';
import { appConfig } from '../../config/app.config';
import { EventPublisher } from '../ports/event-publisher';
import { Metrics } from '../ports/metrics';
import { OutboxRepository } from '../ports/repositories';
import { TransactionManager } from '../ports/transaction-manager';

@Injectable()
export class PublishOutboxEvents {
  private readonly logger = new Logger(PublishOutboxEvents.name);

  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly metrics: Metrics,
  ) {}

  async execute(now = new Date()): Promise<number> {
    const { outboxBatchSize, outboxLeaseMs } = appConfig.workers;

    return this.transactionManager.withContext(async () => {
      const messages = await this.outbox.claimDue(now, outboxBatchSize, outboxLeaseMs);

      if (messages.length > 0) {
        const failures = new Map((await this.publisher.publish(messages)).map((failure) => [failure.messageId, failure.error]));
        const publishedAt = new Date();

        for (const message of messages) {
          const error = failures.get(message.id);

          if (error) {
            message.scheduleRetry(publishedAt, error);
            await this.outbox.scheduleRetry(message);
            this.metrics.retryScheduled('outbox_publish');
            this.logger.warn({ message: 'outbox publish failed', eventId: message.id, attempts: message.attempts, error });
            continue;
          }

          message.markPublished(publishedAt);
          await this.outbox.markPublished(message);
        }

        this.metrics.outboxPublished(messages.length - failures.size);
      }

      await this.refreshBacklog();
      return messages.length;
    });
  }

  private async refreshBacklog(): Promise<void> {
    const backlog = await this.outbox.backlog();
    const lagSeconds = backlog.oldestOccurredAt ? Math.max(0, (Date.now() - backlog.oldestOccurredAt.getTime()) / 1000) : 0;

    this.metrics.outboxBacklog(backlog.pending, lagSeconds);
  }
}
