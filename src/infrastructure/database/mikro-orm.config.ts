import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { appConfig } from '../../config/app.config';
import { InboxMessageSchema, OutboxMessageSchema } from './entities/messaging.entity';
import { WagerTransactionSchema } from './entities/wager-transaction.entity';
import { WalletLedgerEntrySchema } from './entities/wallet-ledger-entry.entity';
import { WalletSchema } from './entities/wallet.entity';
import { Migration20261012000000InitialSchema } from './migrations/Migration20261012000000InitialSchema';

export function databaseConfig(overrides: { dbName?: string; poolMax?: number } = {}) {
  const { database } = appConfig;

  return defineConfig({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    dbName: overrides.dbName ?? database.name,
    pool: { min: 0, max: overrides.poolMax ?? database.poolMax },
    entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema],
    extensions: [Migrator],
    migrations: {
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        { name: 'Migration20261012000000InitialSchema', class: Migration20261012000000InitialSchema },
      ],
    },
    forceUtcTimezone: true,
    debug: false,
  });
}
