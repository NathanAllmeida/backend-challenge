import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WagerTransactionRepository } from '../../../application/ports/repositories';
import { Money } from '../../../domain/money/money';
import { FailureCode } from '../../../domain/wager/failure-code';
import { WagerTransaction } from '../../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey }, { refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId }, { refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });

    return count > 0;
  }

  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows: Array<{ id: string; wallet_id: string }> = await this.em.execute(
      `UPDATE wager_transactions
          SET next_reference_check_at = ?::timestamptz + (? * interval '1 millisecond')
        WHERE id IN (
          SELECT id
            FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
             AND next_reference_check_at <= ?
           ORDER BY next_reference_check_at
           LIMIT ?
             FOR UPDATE SKIP LOCKED
        )
      RETURNING id, wallet_id`,
      [now, leaseMs, now, limit],
    );

    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const data = {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toString(),
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      observedBalance: transaction.observedBalance?.toString() ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
      processedAt: transaction.processedAt ?? null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };

    const entity = this.em.getUnitOfWork().getById<WagerTransactionEntity>(WagerTransactionEntity.name, transaction.id);

    if (entity) {
      this.em.assign(entity, data);
      return;
    }

    this.em.persist(this.em.create(WagerTransactionEntity, data));
  }

  private toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const money = Money.from({ amount: entity.amount, currency: entity.currency });

    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      status: entity.status as WagerTransactionStatus,
      failureCode: (entity.failureCode as FailureCode | null) ?? undefined,
      observedBalance: entity.observedBalance ? Money.from({ amount: entity.observedBalance, currency: entity.currency }) : undefined,
      referenceAttempts: entity.referenceAttempts,
      nextReferenceCheckAt: entity.nextReferenceCheckAt ?? undefined,
      processedAt: entity.processedAt ?? undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
