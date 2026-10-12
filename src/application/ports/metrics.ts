export abstract class Metrics {
  abstract transactionSettled(status: string, kind: string, source: string): void;
  abstract duplicateDetected(source: 'idempotency' | 'inbox'): void;
  abstract retryScheduled(reason: string): void;
  abstract sentToDlq(reason: string): void;
  abstract lockConflict(reason: string): void;
  abstract processingDuration(source: string, seconds: number): void;
  abstract outboxPublished(count: number): void;
  abstract outboxBacklog(pending: number, lagSeconds: number): void;
  abstract reconciliationMismatch(): void;
}
