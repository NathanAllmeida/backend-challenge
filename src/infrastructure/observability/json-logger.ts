import { LoggerService } from '@nestjs/common';
import { appConfig } from '../../config/app.config';
import { LogContext } from './log-context';

type Level = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set(['payload', 'body', 'money', 'balance', 'authorization', 'password']);

export class JsonLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    if (process.env.LOG_LEVEL === 'debug') {
      this.write('debug', message, rest);
    }
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.debug(message, ...rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    const context = typeof rest.at(-1) === 'string' ? rest.at(-1) as string : undefined;
    const fields = typeof message === 'object' && message !== null ? sanitize(message as Record<string, unknown>) : { message: String(message) };

    const line = {
      timestamp: new Date().toISOString(),
      level,
      instance: appConfig.instanceId,
      context,
      ...LogContext.current(),
      ...fields,
    };

    const output = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    output.write(`${JSON.stringify(line)}\n`);
  }
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !SENSITIVE_KEYS.has(key)));
}
