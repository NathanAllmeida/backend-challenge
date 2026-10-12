import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { LogContext } from '../infrastructure/observability/log-context';

export const CORRELATION_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const received = request.header(CORRELATION_HEADER);
    const correlationId = received && received.length <= 128 ? received : uuidv7();

    response.setHeader(CORRELATION_HEADER, correlationId);
    LogContext.run({ correlationId }, next);
  }
}

export function correlationIdOf(request: Request): string {
  return LogContext.current().correlationId ?? String(request.header(CORRELATION_HEADER) ?? uuidv7());
}
