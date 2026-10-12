import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | null>;
  abstract lockById(id: string): Promise<Wallet | null>;
  abstract lockForShare(id: string): Promise<Wallet | null>;
  abstract save(wallet: Wallet): Promise<void>;
}

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  abstract lockById(id: string): Promise<WagerTransaction | null>;
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  abstract claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>>;
  abstract save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageEntry {
  position: string;
  entry: WalletLedgerEntry;
}

export interface LedgerSummary {
  credits: string;
  debits: string;
  entries: number;
}

export abstract class LedgerRepository {
  abstract add(entry: WalletLedgerEntry): Promise<void>;
  abstract page(walletId: string, afterPosition: string | undefined, limit: number): Promise<LedgerPageEntry[]>;
  abstract summarize(walletId: string): Promise<LedgerSummary>;
}

export abstract class InboxRepository {
  abstract register(message: InboxMessage): Promise<boolean>;
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  abstract save(message: InboxMessage): Promise<void>;
}

export interface OutboxBacklog {
  pending: number;
  oldestOccurredAt?: Date;
}

export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
  abstract claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  abstract markPublished(message: OutboxMessage): Promise<void>;
  abstract scheduleRetry(message: OutboxMessage): Promise<void>;
  abstract backlog(): Promise<OutboxBacklog>;
}
