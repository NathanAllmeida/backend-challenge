export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class DuplicateExternalTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_EXTERNAL_TRANSACTION';
}

export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string, public readonly details: string[] = []) {
    super(message);
  }
}

export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(public readonly constraint: string | undefined, cause?: unknown) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
    this.cause = cause;
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';

  constructor(message: string, public readonly reason: 'lock_timeout' | 'deadlock' | 'connection' | 'publish' = 'connection', cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
