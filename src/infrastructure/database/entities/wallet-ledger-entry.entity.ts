import { EntitySchema } from '@mikro-orm/core';

export class WalletLedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2, fieldName: 'balance_before' },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2, fieldName: 'balance_after' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
