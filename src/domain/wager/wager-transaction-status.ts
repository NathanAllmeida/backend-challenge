export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
] as const;
