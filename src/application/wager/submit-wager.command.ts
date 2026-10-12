import { MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export type WagerSource = 'http' | 'sqs';

export interface WagerOrigin {
  source: WagerSource;
  correlationId: string;
  causationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
  };
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toWagerResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance!.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}
