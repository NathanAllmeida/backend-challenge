import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogFields>();

export const LogContext = {
  run<T>(fields: LogFields, work: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, work);
  },

  enrich(fields: LogFields): void {
    const current = storage.getStore();

    if (current) {
      Object.assign(current, fields);
    }
  },

  current(): LogFields {
    return storage.getStore() ?? {};
  },
};
