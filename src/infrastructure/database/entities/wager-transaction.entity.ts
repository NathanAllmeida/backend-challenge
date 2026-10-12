import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  processedAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    observedBalance: { type: 'decimal', precision: 20, scale: 2, fieldName: 'observed_balance', nullable: true },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceCheckAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_reference_check_at', nullable: true },
    processedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
