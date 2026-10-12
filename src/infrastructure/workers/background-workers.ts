import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutboxEvents } from '../../application/outbox/publish-outbox-events.use-case';
import { ResolvePendingReferences } from '../../application/wager/resolve-pending-references.use-case';
import { appConfig } from '../../config/app.config';
import { WagerTransactionConsumer } from '../messaging/wager-transaction.consumer';
import { PollingLoop } from './polling-loop';

@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundWorkers.name);
  private readonly loops: PollingLoop[];

  constructor(
    private readonly consumer: WagerTransactionConsumer,
    publishOutbox: PublishOutboxEvents,
    resolvePendingReferences: ResolvePendingReferences,
  ) {
    this.loops = [
      new PollingLoop('OutboxPublisher', appConfig.workers.outboxIntervalMs, () => publishOutbox.execute()),
      new PollingLoop('PendingReferenceResolver', appConfig.workers.pendingReferenceIntervalMs, () => resolvePendingReferences.execute()),
    ];
  }

  onApplicationBootstrap(): void {
    if (!appConfig.workersEnabled) {
      this.logger.log({ message: 'background workers disabled' });
      return;
    }

    this.consumer.start();
    this.loops.forEach((loop) => loop.start());
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({ message: 'stopping background workers', signal });

    await this.consumer.stop();
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
