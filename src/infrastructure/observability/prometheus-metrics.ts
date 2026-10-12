import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Metrics } from '../../application/ports/metrics';
import { appConfig } from '../../config/app.config';

@Injectable()
export class PrometheusMetrics extends Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by final status',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicated requests or messages detected',
    labelNames: ['layer'],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled for transient failures or pending references',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly dlq = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Messages moved to the dead letter queue',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock timeouts and deadlocks while touching a wallet',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to settle a wager transaction',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly published = new Counter({
    name: 'outbox_published_total',
    help: 'Integration events published from the outbox',
    registers: [this.registry],
  });

  private readonly pending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Events waiting to be published',
    registers: [this.registry],
  });

  private readonly lag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished event',
    registers: [this.registry],
  });

  private readonly reconciliation = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Reconciliations where the stored balance diverged from the ledger',
    registers: [this.registry],
  });

  constructor() {
    super();
    this.registry.setDefaultLabels({ instance: appConfig.instanceId });
    collectDefaultMetrics({ register: this.registry });
  }

  transactionSettled(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicateDetected(layer: 'idempotency' | 'inbox'): void {
    this.duplicates.inc({ layer });
  }

  retryScheduled(reason: string): void {
    this.retries.inc({ reason });
  }

  sentToDlq(reason: string): void {
    this.dlq.inc({ reason });
  }

  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }

  processingDuration(source: string, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }

  outboxPublished(count: number): void {
    this.published.inc(count);
  }

  outboxBacklog(pending: number, lagSeconds: number): void {
    this.pending.set(pending);
    this.lag.set(lagSeconds);
  }

  reconciliationMismatch(): void {
    this.reconciliation.inc();
  }
}
