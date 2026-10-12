import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WalletRepository } from '../../../application/ports/repositories';
import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { WalletEntity } from '../entities/wallet.entity';

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async lockForShare(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_READ, refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const data = {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };

    const entity = this.em.getUnitOfWork().getById<WalletEntity>(WalletEntity.name, wallet.id);

    if (entity) {
      this.em.assign(entity, data);
      return;
    }

    this.em.persist(this.em.create(WalletEntity, data));
  }

  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balance, currency: entity.currency }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
