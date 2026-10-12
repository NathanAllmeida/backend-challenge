import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Money, MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueViolationError, WalletAlreadyExistsError } from '../errors/application.error';
import { WalletRepository } from '../ports/repositories';
import { TransactionManager } from '../ports/transaction-manager';
import { canonicalJson, sha256 } from '../wager/payload-hash';
import { WagerSettlementService } from '../wager/wager-settlement.service';
import { toWalletView, WalletView } from './wallet.views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class OpenWallet {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
    private readonly settlement: WagerSettlementService,
  ) {}

  async execute(command: OpenWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.transactionManager.run(async () => {
        const now = new Date();
        const wallet = Wallet.open({ id: uuidv7(), playerId: command.playerId, initialBalance, openedAt: now });

        await this.wallets.save(wallet);

        if (initialBalance.isPositive()) {
          await this.registerOpeningCredit(wallet, correlationId, now);
        }

        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }

      throw error;
    }
  }

  private async registerOpeningCredit(wallet: Wallet, correlationId: string, now: Date): Promise<void> {
    const opening = WagerTransaction.opening({
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      payloadHash: sha256(canonicalJson({ playerId: wallet.playerId, initialBalance: { ...wallet.balance.toJSON() } })),
      at: now,
    });

    const entry = wallet.openingEntry(opening.id);
    opening.markProcessed(undefined, now, wallet.balance);

    await this.settlement.persist(opening, wallet, entry, { correlationId, causationId: wallet.id, occurredAt: now });
  }
}
