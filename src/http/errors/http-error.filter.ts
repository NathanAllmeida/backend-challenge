import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InvalidRequestError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors/application.error';
import { DomainError } from '../../domain/errors/domain.error';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(error);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }

    if (status >= 500) {
      this.logger.error({ message: 'request failed', status, code: body.error.code, error: (error as Error)?.message });
    }

    response.status(status).json(body);
  }

  private map(error: unknown): [number, ErrorBody] {
    if (error instanceof InvalidRequestError) {
      return [HttpStatus.BAD_REQUEST, body(error.code, error.message, error.details)];
    }

    if (error instanceof DomainError) {
      return [HttpStatus.BAD_REQUEST, body(error.code, error.message)];
    }

    if (error instanceof ResourceNotFoundError) {
      return [HttpStatus.NOT_FOUND, body(error.code, error.message)];
    }

    if (
      error instanceof IdempotencyConflictError
      || error instanceof DuplicateExternalTransactionError
      || error instanceof WalletAlreadyExistsError
      || error instanceof UniqueViolationError
    ) {
      return [HttpStatus.CONFLICT, body(error.code, error.message)];
    }

    if (error instanceof WalletNotFoundError) {
      return [HttpStatus.UNPROCESSABLE_ENTITY, body(error.code, error.message)];
    }

    if (error instanceof TransientInfrastructureError) {
      return [HttpStatus.SERVICE_UNAVAILABLE, body(error.code, error.message)];
    }

    if (error instanceof HttpException) {
      return [error.getStatus(), body(HttpStatus[error.getStatus()] ?? 'HTTP_ERROR', error.message)];
    }

    if (error instanceof ApplicationError) {
      return [HttpStatus.INTERNAL_SERVER_ERROR, body(error.code, error.message)];
    }

    return [HttpStatus.INTERNAL_SERVER_ERROR, body('INTERNAL_ERROR', 'Unexpected error')];
  }
}

function body(code: string, message: string, details?: string[]): ErrorBody {
  return { error: { code, message, ...(details?.length ? { details } : {}) } };
}
