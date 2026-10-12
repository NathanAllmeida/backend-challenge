import { LedgerDirection } from '../wallet/ledger-direction';
import { Wallet } from '../wallet/wallet';
import { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';

export interface SettlementContext {
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
  now: Date;
}

const AWAIT_REFERENCE = 'AWAIT_REFERENCE';

type Verdict = FailureCode | typeof AWAIT_REFERENCE | undefined;

export class WagerSettlement {
  static settle(transaction: WagerTransaction, wallet: Wallet, context: SettlementContext): WalletLedgerEntry | undefined {
    const { reference, now } = context;
    const verdict = WagerSettlement.verdict(transaction, wallet, context);

    if (verdict === AWAIT_REFERENCE) {
      transaction.markPendingReference(now, wallet.balance);
      return undefined;
    }

    if (verdict) {
      transaction.reject(verdict, now, wallet.balance);
      return undefined;
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      return undefined;
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      const code = transaction.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds;

      transaction.reject(code, now, wallet.balance);
      return undefined;
    }

    const entry = wallet.move(direction, transaction.money, transaction.id, now);
    transaction.markProcessed(reference?.id, now, wallet.balance);

    return entry;
  }

  private static verdict(transaction: WagerTransaction, wallet: Wallet, context: SettlementContext): Verdict {
    if (transaction.playerId !== wallet.playerId) {
      return FailureCode.PlayerMismatch;
    }

    if (!transaction.money.hasCurrency(wallet.currency)) {
      return FailureCode.CurrencyMismatch;
    }

    if (!transaction.hasReference()) {
      return undefined;
    }

    return WagerSettlement.referenceVerdict(transaction, context);
  }

  private static referenceVerdict(transaction: WagerTransaction, context: SettlementContext): Verdict {
    const { reference } = context;

    if (!reference) {
      return AWAIT_REFERENCE;
    }

    if (!transaction.belongsToSameRoundAs(reference)) {
      return FailureCode.ReferenceMismatch;
    }

    if (!transaction.canReference(reference)) {
      return FailureCode.ReferenceKindNotAllowed;
    }

    if (reference.isAwaitingReference()) {
      return AWAIT_REFERENCE;
    }

    if (!reference.isProcessed()) {
      return FailureCode.ReferenceNotProcessed;
    }

    if (!transaction.requiresReference()) {
      return undefined;
    }

    if (!transaction.money.equals(reference.money)) {
      return FailureCode.AmountMismatch;
    }

    if (context.referenceAlreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }

    return undefined;
  }
}
