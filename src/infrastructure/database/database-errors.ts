import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors/application.error';

const TRANSIENT_SQLSTATES = new Set(['55P03', '40P01', '40001', '57P01', '57P02', '57P03', '08000', '08003', '08006', '53300']);
const CONNECTION_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

interface DriverError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  message?: string;
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as DriverError).constraint, error);
  }

  if (error instanceof LockWaitTimeoutException) {
    return new TransientInfrastructureError('Timed out waiting for a wallet lock', 'lock_timeout', error);
  }

  if (error instanceof DeadlockException) {
    return new TransientInfrastructureError('Deadlock detected', 'deadlock', error);
  }

  if (error instanceof ConnectionException || isTransientDriverError(error)) {
    return new TransientInfrastructureError('Database is temporarily unavailable', 'connection', error);
  }

  return error;
}

function isTransientDriverError(error: unknown): boolean {
  const driverError = error as DriverError | undefined;
  const code = driverError?.sqlState ?? driverError?.code;

  if (code && (TRANSIENT_SQLSTATES.has(code) || CONNECTION_ERRNOS.has(code))) {
    return true;
  }

  return /connection terminated|timeout exceeded when trying to connect|Connection terminated unexpectedly/i.test(driverError?.message ?? '');
}
