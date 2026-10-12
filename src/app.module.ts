import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PublishOutboxEvents } from './application/outbox/publish-outbox-events.use-case';
import { EventPublisher } from './application/ports/event-publisher';
import { Metrics } from './application/ports/metrics';
import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './application/ports/repositories';
import { TransactionManager } from './application/ports/transaction-manager';
import { ResolvePendingReferences } from './application/wager/resolve-pending-references.use-case';
import { SubmitWagerTransaction } from './application/wager/submit-wager-transaction.use-case';
import { WagerQueries } from './application/wager/wager-queries';
import { WagerSettlementService } from './application/wager/wager-settlement.service';
import { OpenWallet } from './application/wallet/open-wallet.use-case';
import { ReconcileWallet } from './application/wallet/reconcile-wallet.use-case';
import { WalletQueries } from './application/wallet/wallet-queries';
import { AllowAllProviderIdentity, AuthGuard, ProviderIdentityPort } from './http/auth/auth.guard';
import { HealthController } from './http/controllers/health.controller';
import { WageringController } from './http/controllers/wagering.controller';
import { WalletsController } from './http/controllers/wallets.controller';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { HttpErrorFilter } from './http/errors/http-error.filter';
import { databaseConfig } from './infrastructure/database/mikro-orm.config';
import { MikroOrmTransactionManager } from './infrastructure/database/mikro-orm-transaction-manager';
import { MikroOrmInboxRepository } from './infrastructure/database/repositories/mikro-orm-inbox.repository';
import { MikroOrmLedgerRepository } from './infrastructure/database/repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './infrastructure/database/repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/database/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './infrastructure/database/repositories/mikro-orm-wallet.repository';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsQueues } from './infrastructure/messaging/sqs-queues';
import { WagerTransactionConsumer } from './infrastructure/messaging/wager-transaction.consumer';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { BackgroundWorkers } from './infrastructure/workers/background-workers';

const useCases = [
  OpenWallet,
  ReconcileWallet,
  WalletQueries,
  SubmitWagerTransaction,
  ResolvePendingReferences,
  WagerSettlementService,
  WagerQueries,
  PublishOutboxEvents,
];

const persistence = [
  { provide: TransactionManager, useClass: MikroOrmTransactionManager },
  { provide: WalletRepository, useClass: MikroOrmWalletRepository },
  { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
  { provide: LedgerRepository, useClass: MikroOrmLedgerRepository },
  { provide: InboxRepository, useClass: MikroOrmInboxRepository },
  { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
];

const messaging = [
  SqsQueues,
  { provide: EventPublisher, useClass: SqsEventPublisher },
  WagerTransactionConsumer,
  BackgroundWorkers,
];

const observability = [
  PrometheusMetrics,
  { provide: Metrics, useExisting: PrometheusMetrics },
];

const http = [
  { provide: ProviderIdentityPort, useClass: AllowAllProviderIdentity },
  { provide: APP_GUARD, useClass: AuthGuard },
  { provide: APP_FILTER, useClass: HttpErrorFilter },
];

@Module({
  imports: [MikroOrmModule.forRoot(databaseConfig())],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [...useCases, ...persistence, ...messaging, ...observability, ...http],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
