import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SqsQueues } from '../../infrastructure/messaging/sqs-queues';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { Public } from '../auth/auth.guard';

const CHECK_TIMEOUT_MS = 2_000;

@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly queues: SqsQueues,
    private readonly metrics: PrometheusMetrics,
  ) {}

  @Get('health/live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res() response: Response): Promise<void> {
    const [database, sqs] = await Promise.all([
      this.check(() => this.em.getConnection().execute('SELECT 1')),
      this.check(async () => this.queues.client.send(new GetQueueAttributesCommand({
        QueueUrl: await this.queues.wager(),
        AttributeNames: ['QueueArn'],
      }))),
    ]);

    const ready = database === 'up' && sqs === 'up';
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks: { database, sqs } });
  }

  @Get('metrics')
  async prometheus(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    response.send(await this.metrics.registry.metrics());
  }

  private async check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await Promise.race([
        probe(),
        Bun.sleep(CHECK_TIMEOUT_MS).then(() => {
          throw new Error('timeout');
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
