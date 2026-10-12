import { Injectable, Logger } from '@nestjs/common';
import { Money } from '../../domain/money/money';
import { ResourceNotFoundError } from '../errors/application.error';
import { Metrics } from '../ports/metrics';
import { LedgerRepository, WalletRepository } from '../ports/repositories';
import { TransactionManager } from '../ports/transaction-manager';
import { ReconciliationView } from './wallet.views';

@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const report = await this.transactionManager.run(async () => {
      const wallet = await this.wallets.lockForShare(walletId);

      if (!wallet) {
        throw new ResourceNotFoundError(`Wallet ${walletId} not found`);
      }

      const summary = await this.ledger.summarize(walletId);
      const credits = Money.from({ amount: summary.credits, currency: wallet.currency });
      const debits = Money.from({ amount: summary.debits, currency: wallet.currency });
      const calculated = credits.subtract(debits);
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });

    if (!report.consistent) {
      this.metrics.reconciliationMismatch();
      this.logger.error({
        message: 'wallet balance diverges from ledger',
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }

    return report;
  }
}
