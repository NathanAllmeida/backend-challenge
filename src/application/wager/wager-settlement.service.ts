import { Injectable } from '@nestjs/common';
import { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerSettlement } from '../../domain/wager/wager-settlement';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { LedgerRepository, OutboxRepository, WagerTransactionRepository, WalletRepository } from '../ports/repositories';

@Injectable()
export class WagerSettlementService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async settle(transaction: WagerTransaction, wallet: Wallet, context: EventContext): Promise<void> {
    const entry = await this.decide(transaction, wallet, context.occurredAt);
    await this.persist(transaction, wallet, entry, context);
  }

  async decide(transaction: WagerTransaction, wallet: Wallet, now: Date): Promise<WalletLedgerEntry | undefined> {
    const reference = await this.findReference(transaction);
    const referenceAlreadyReversed = reference && transaction.requiresReference()
      ? await this.transactions.hasProcessedReversal(reference.id)
      : false;

    return WagerSettlement.settle(transaction, wallet, { reference, referenceAlreadyReversed, now });
  }

  async persist(transaction: WagerTransaction, wallet: Wallet, entry: WalletLedgerEntry | undefined, context: EventContext): Promise<void> {
    await this.transactions.save(transaction);

    if (entry) {
      await this.wallets.save(wallet);
      await this.ledger.add(entry);
    }

    for (const event of this.eventsFor(transaction, wallet, entry, context)) {
      await this.outbox.add(OutboxMessage.enqueue(event));
    }
  }

  private async findReference(transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    if (!transaction.referenceExternalTransactionId) {
      return undefined;
    }

    const reference = await this.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId);
    return reference ?? undefined;
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): IntegrationEvent<unknown>[] {
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        return entry
          ? [WagerTransactionProcessed.from(transaction, wallet, context), WalletBalanceChanged.from(wallet, entry, context)]
          : [WagerTransactionProcessed.from(transaction, wallet, context)];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, context)];
      case WagerTransactionStatus.PendingReference:
        return transaction.referenceAttempts === 1 ? [WagerTransactionPendingReference.from(transaction, context)] : [];
      default:
        return [];
    }
  }
}
