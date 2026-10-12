import { Injectable } from '@nestjs/common';
import { MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { ResourceNotFoundError } from '../errors/application.error';
import { WagerTransactionRepository } from '../ports/repositories';

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

@Injectable()
export class WagerQueries {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  async findById(transactionId: string): Promise<WagerTransactionView> {
    return this.toView(await this.transactions.findById(transactionId), transactionId);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    return this.toView(await this.transactions.findByExternalId(providerId, externalTransactionId), `${providerId}/${externalTransactionId}`);
  }

  private toView(transaction: WagerTransaction | null, lookup: string): WagerTransactionView {
    if (!transaction) {
      throw new ResourceNotFoundError(`Wager transaction ${lookup} not found`);
    }

    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      balance: transaction.observedBalance?.toJSON() ?? null,
      createdAt: transaction.createdAt.toISOString(),
      processedAt: transaction.processedAt?.toISOString() ?? null,
    };
  }
}
