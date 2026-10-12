import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { TransientInfrastructureError } from '../../application/errors/application.error';
import { Metrics } from '../../application/ports/metrics';
import { TransactionManager } from '../../application/ports/transaction-manager';
import { appConfig } from '../../config/app.config';
import { translateDatabaseError } from './database-errors';

@Injectable()
export class MikroOrmTransactionManager extends TransactionManager {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const lockTimeout = Math.max(1, Math.trunc(appConfig.database.lockTimeoutMs));

    try {
      return await this.em.transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
        return work();
      }, { clear: true });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async withContext<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await RequestContext.create(this.em, work);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    const translated = translateDatabaseError(error);

    if (translated instanceof TransientInfrastructureError && translated.reason !== 'connection') {
      this.metrics.lockConflict(translated.reason);
    }

    return translated;
  }
}
