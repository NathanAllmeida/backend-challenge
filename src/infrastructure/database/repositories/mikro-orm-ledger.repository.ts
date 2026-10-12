import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { LedgerPageEntry, LedgerRepository, LedgerSummary } from '../../../application/ports/repositories';
import { Money } from '../../../domain/money/money';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

interface LedgerRow {
  id: string;
  position: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

@Injectable()
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(this.em.create(WalletLedgerEntryEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    }));
  }

  async page(walletId: string, afterPosition: string | undefined, limit: number): Promise<LedgerPageEntry[]> {
    const rows: LedgerRow[] = await this.em.execute(
      `SELECT id, position::text AS position, wallet_id, transaction_id, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ?
          AND position > ?
        ORDER BY position
        LIMIT ?`,
      [walletId, afterPosition ?? '0', limit],
    );

    return rows.map((row) => ({ position: row.position, entry: this.toDomain(row) }));
  }

  async summarize(walletId: string): Promise<LedgerSummary> {
    const [row]: Array<{ credits: string; debits: string; entries: string }> = await this.em.execute(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
              COUNT(*)::text AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );

    return { credits: row!.credits, debits: row!.debits, entries: Number(row!.entries) };
  }

  private toDomain(row: LedgerRow): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: row.currency });

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      direction: row.direction as LedgerDirection,
      money: money(row.amount),
      balanceBefore: money(row.balance_before),
      balanceAfter: money(row.balance_after),
      createdAt: new Date(row.created_at),
    });
  }
}
