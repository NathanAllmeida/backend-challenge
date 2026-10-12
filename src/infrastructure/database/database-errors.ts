import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors/application.error';

const LOCK_TIMEOUT = '55P03';
const DEADLOCK = '40P01';
const SERIALIZATION_FAILURE = '40001';
const CONNECTION_SQLSTATES = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006', '53300']);
const CONNECTION_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
const CONNECTION_MESSAGES = /connection terminated|timeout exceeded when trying to connect|timeout acquiring a connection/i;

interface DriverError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  message?: string;
}

export function translateDatabaseError(error: unknown): unknown {
  const driverError = error as DriverError | undefined;
  const code = driverError?.sqlState ?? driverError?.code;

  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError(driverError?.constraint, error);
  }

  if (error instanceof LockWaitTimeoutException || code === LOCK_TIMEOUT) {
    return new TransientInfrastructureError('Timed out waiting for a wallet lock', 'lock_timeout', error);
  }

  if (error instanceof DeadlockException || code === DEADLOCK || code === SERIALIZATION_FAILURE) {
    return new TransientInfrastructureError('Concurrent update conflict', 'deadlock', error);
  }

  if (
    error instanceof ConnectionException
    || (code !== undefined && (CONNECTION_SQLSTATES.has(code) || CONNECTION_ERRNOS.has(code)))
    || CONNECTION_MESSAGES.test(driverError?.message ?? '')
  ) {
    return new TransientInfrastructureError('Database is temporarily unavailable', 'connection', error);
  }

  return error;
}
