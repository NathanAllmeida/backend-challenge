function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;

  if (value === undefined) {
    throw new Error(`Missing environment variable ${name}`);
  }

  return value;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(env(name, String(fallback)), 10);

  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }

  return value;
}

export const appConfig = {
  port: envInt('PORT', 3000),
  instanceId: env('INSTANCE_ID', `instance-${process.pid}`),
  workersEnabled: env('WORKERS_ENABLED', 'true') === 'true',

  database: {
    host: env('DATABASE_HOST', 'localhost'),
    port: envInt('DATABASE_PORT', 5432),
    user: env('DATABASE_USER', 'wallet'),
    password: env('DATABASE_PASSWORD', 'wallet'),
    name: env('DATABASE_NAME', 'wallet'),
    poolMax: envInt('DATABASE_POOL_MAX', 20),
    lockTimeoutMs: envInt('DATABASE_LOCK_TIMEOUT_MS', 5_000),
  },

  sqs: {
    region: env('AWS_REGION', 'us-east-1'),
    endpoint: process.env.SQS_ENDPOINT || undefined,
    wagerQueue: env('SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
    wagerDlq: env('SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
    eventsQueue: env('SQS_EVENTS_QUEUE', 'wallet-events.fifo'),
    maxReceiveCount: envInt('SQS_MAX_RECEIVE_COUNT', 5),
    visibilityTimeoutSeconds: envInt('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
    waitTimeSeconds: envInt('SQS_WAIT_TIME_SECONDS', 10),
    batchSize: envInt('SQS_BATCH_SIZE', 10),
  },

  workers: {
    outboxIntervalMs: envInt('OUTBOX_INTERVAL_MS', 500),
    outboxBatchSize: envInt('OUTBOX_BATCH_SIZE', 50),
    outboxLeaseMs: envInt('OUTBOX_LEASE_MS', 30_000),
    pendingReferenceIntervalMs: envInt('PENDING_REFERENCE_INTERVAL_MS', 1_000),
    pendingReferenceBatchSize: envInt('PENDING_REFERENCE_BATCH_SIZE', 50),
    pendingReferenceLeaseMs: envInt('PENDING_REFERENCE_LEASE_MS', 30_000),
  },
};

export type AppConfig = typeof appConfig;
