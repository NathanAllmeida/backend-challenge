import { MoneyProps } from '../money/money';
import { FailureCode } from '../wager/failure-code';
import { WagerTransaction } from '../wager/wager-transaction';
import { WagerTransactionKind } from '../wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../wager/wager-transaction-status';
import { LedgerDirection } from '../wallet/ledger-direction';
import { Wallet } from '../wallet/wallet';
import { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { EventContext, IntegrationEvent } from './integration-event';

interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
}

function transactionData(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, wallet: Wallet, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(IntegrationEvent.props(transaction.id, {
      ...transactionData(transaction),
      referenceTransactionId: transaction.referenceTransactionId,
      balance: wallet.balance.toJSON(),
      processedAt: (transaction.processedAt ?? context.occurredAt).toISOString(),
    }, context));
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(IntegrationEvent.props(transaction.id, {
      ...transactionData(transaction),
      failureCode: transaction.failureCode!,
    }, context));
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  referenceAttempts: number;
  nextReferenceCheckAt?: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(IntegrationEvent.props(transaction.id, {
      ...transactionData(transaction),
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceCheckAt: transaction.nextReferenceCheckAt?.toISOString(),
    }, context));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(IntegrationEvent.props(wallet.id, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    }, context));
  }
}
