import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './mikro-orm.config';

const direction = process.argv[2] ?? 'up';
const orm = await MikroORM.init(databaseConfig({ dbName: process.env.DATABASE_NAME }));
const migrator = orm.getMigrator();

try {
  const executed = direction === 'down' ? await migrator.down() : await migrator.up();
  const names = executed.map((migration) => migration.name);

  console.log(JSON.stringify({ level: 'info', message: `migrations ${direction}`, migrations: names }));
} finally {
  await orm.close(true);
}
