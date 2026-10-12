import 'reflect-metadata';

process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'wallet_test';
process.env.WORKERS_ENABLED = 'false';
process.env.DATABASE_LOCK_TIMEOUT_MS = '15000';
process.env.DATABASE_POOL_MAX = '30';
process.env.SQS_WAGER_QUEUE = 'test-wager-transactions.fifo';
process.env.SQS_WAGER_DLQ = 'test-wager-transactions-dlq.fifo';
process.env.SQS_EVENTS_QUEUE = 'test-wallet-events.fifo';
process.env.SQS_MAX_RECEIVE_COUNT = '3';
process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = '5';
process.env.SQS_WAIT_TIME_SECONDS = '1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
