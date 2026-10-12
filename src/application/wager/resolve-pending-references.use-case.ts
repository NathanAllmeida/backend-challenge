import { Injectable, Logger } from '@nestjs/common';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { appConfig } from '../../config/app.config';
import { TransientInfrastructureError } from '../errors/application.error';
import { Metrics } from '../ports/metrics';
import { WagerTransactionRepository, WalletRepository } from '../ports/repositories';
import { TransactionManager } from '../ports/transaction-manager';
import { WagerSettlementService } from './wager-settlement.service';

@Injectable()
export class ResolvePendingReferences {
  private readonly logger = new Logger(ResolvePendingReferences.name);

  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly settlement: WagerSettlementService,
    private readonly metrics: Metrics,
  ) {}

  async execute(now = new Date()): Promise<number> {
    const { pendingReferenceBatchSize, pendingReferenceLeaseMs } = appConfig.workers;

    const claimed = await this.transactionManager.withContext(
      () => this.transactions.claimDuePendingReferences(now, pendingReferenceBatchSize, pendingReferenceLeaseMs),
    );

    for (const { id, walletId } of claimed) {
      await this.retry(id, walletId);
    }

    return claimed.length;
  }

  private async retry(transactionId: string, walletId: string): Promise<void> {
    try {
      const transaction = await this.transactionManager.run(() => this.resolve(transactionId, walletId));

      if (transaction?.isTerminal()) {
        this.metrics.transactionSettled(transaction.status, transaction.kind, 'pending_reference');
        this.logger.log({ message: 'pending reference resolved', transactionId, walletId, status: transaction.status, failureCode: transaction.failureCode });
      } else if (transaction) {
        this.metrics.retryScheduled('pending_reference');
      }
    } catch (error) {
      if (error instanceof TransientInfrastructureError) {
        this.metrics.retryScheduled('pending_reference_transient');
        this.logger.warn({ message: 'pending reference retry postponed', transactionId, walletId, reason: error.reason });
        return;
      }

      this.logger.error({ message: 'pending reference failed permanently', transactionId, walletId, error: (error as Error).message });
      await this.transactionManager.run(() => this.markFailed(transactionId, walletId));
    }
  }

  private async resolve(transactionId: string, walletId: string): Promise<WagerTransaction | undefined> {
    const wallet = await this.wallets.lockById(walletId);
    const transaction = await this.transactions.lockById(transactionId);

    if (!wallet || !transaction?.isAwaitingReference()) {
      return undefined;
    }

    const now = new Date();
    const entry = await this.settlement.decide(transaction, wallet, now);

    if (transaction.isAwaitingReference() && transaction.hasExhaustedReferenceAttempts()) {
      transaction.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
    }

    await this.settlement.persist(transaction, wallet, entry, {
      correlationId: transaction.idempotencyKey,
      causationId: transaction.id,
      occurredAt: now,
    });

    return transaction;
  }

  private async markFailed(transactionId: string, walletId: string): Promise<void> {
    const wallet = await this.wallets.lockById(walletId);
    const transaction = await this.transactions.lockById(transactionId);

    if (!wallet || !transaction || transaction.isTerminal()) {
      return;
    }

    transaction.fail(FailureCode.ProcessingError, new Date());
    await this.transactions.save(transaction);
  }
}
