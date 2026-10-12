import { Injectable } from '@nestjs/common';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  ResourceNotFoundError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors/application.error';
import { Metrics } from '../ports/metrics';
import { InboxRepository, WagerTransactionRepository, WalletRepository } from '../ports/repositories';
import { TransactionManager } from '../ports/transaction-manager';
import { wagerPayloadHash } from './payload-hash';
import { SubmitWagerCommand, toWagerResult, WagerOrigin, WagerTransactionResult } from './submit-wager.command';
import { WagerSettlementService } from './wager-settlement.service';

@Injectable()
export class SubmitWagerTransaction {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly settlement: WagerSettlementService,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: SubmitWagerCommand, origin: WagerOrigin): Promise<WagerTransactionResult> {
    const payloadHash = wagerPayloadHash(command);
    const startedAt = performance.now();

    try {
      const result = await this.transactionManager.run(() => this.process(command, origin, payloadHash));

      if (result.idempotentReplay) {
        this.metrics.duplicateDetected('idempotency');
      } else {
        this.metrics.transactionSettled(result.status, command.kind, origin.source);
      }

      return result;
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        return this.resolveUniqueViolation(command, payloadHash, error);
      }

      throw error;
    } finally {
      this.metrics.processingDuration(origin.source, (performance.now() - startedAt) / 1000);
    }
  }

  private async process(command: SubmitWagerCommand, origin: WagerOrigin, payloadHash: string): Promise<WagerTransactionResult> {
    const now = new Date();

    if (origin.inbox) {
      const message = InboxMessage.receive({ ...origin.inbox, payloadHash, receivedAt: now });

      if (!await this.inbox.register(message)) {
        return this.duplicateDelivery(origin.inbox, command, payloadHash);
      }
    }

    const existing = await this.transactions.findByIdempotencyKey(command.idempotencyKey);

    if (existing) {
      await this.markInboxProcessed(origin, payloadHash, now);
      return this.replay(existing, payloadHash);
    }

    const wallet = await this.wallets.lockById(command.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const settledWhileWaiting = await this.transactions.findByIdempotencyKey(command.idempotencyKey);

    if (settledWhileWaiting) {
      await this.markInboxProcessed(origin, payloadHash, now);
      return this.replay(settledWhileWaiting, payloadHash);
    }

    const transaction = WagerTransaction.create({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    await this.settlement.settle(transaction, wallet, {
      correlationId: origin.correlationId,
      causationId: origin.causationId,
      occurredAt: now,
    });
    await this.markInboxProcessed(origin, payloadHash, now);

    return toWagerResult(transaction, false);
  }

  private replay(transaction: WagerTransaction, payloadHash: string): WagerTransactionResult {
    if (!transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(`Idempotency key ${transaction.idempotencyKey} was already used with a different payload`);
    }

    return toWagerResult(transaction, true);
  }

  private async duplicateDelivery(
    inbox: NonNullable<WagerOrigin['inbox']>,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    this.metrics.duplicateDetected('inbox');

    const previous = await this.inbox.find(inbox.consumerName, inbox.messageId);

    if (previous && !previous.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(`Message ${inbox.messageId} was already received with a different payload`);
    }

    const transaction = await this.transactions.findByIdempotencyKey(command.idempotencyKey);

    if (!transaction) {
      throw new ResourceNotFoundError(`Message ${inbox.messageId} was processed but its transaction was not found`);
    }

    return this.replay(transaction, payloadHash);
  }

  private async markInboxProcessed(origin: WagerOrigin, payloadHash: string, at: Date): Promise<void> {
    if (!origin.inbox) {
      return;
    }

    const message = InboxMessage.receive({ ...origin.inbox, payloadHash, receivedAt: at });
    message.markProcessed(at);
    await this.inbox.save(message);
  }

  private resolveUniqueViolation(command: SubmitWagerCommand, payloadHash: string, error: UniqueViolationError): Promise<WagerTransactionResult> {
    return this.transactionManager.withContext(async () => {
      const byKey = await this.transactions.findByIdempotencyKey(command.idempotencyKey);

      if (byKey) {
        this.metrics.duplicateDetected('idempotency');
        return this.replay(byKey, payloadHash);
      }

      const byExternalId = await this.transactions.findByExternalId(command.providerId, command.externalTransactionId);

      if (byExternalId) {
        throw new DuplicateExternalTransactionError(
          `Transaction ${command.externalTransactionId} from ${command.providerId} was already submitted with another idempotency key`,
        );
      }

      throw error;
    });
  }
}
