import { describe, expect, it } from 'bun:test';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wager/failure-code';
import { WagerSettlement } from '@/domain/wager/wager-settlement';
import { WagerTransaction } from '@/domain/wager/wager-transaction';
import { WagerTransactionKind } from '@/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '@/domain/wager/wager-transaction-status';
import { LedgerDirection } from '@/domain/wallet/ledger-direction';
import { Wallet } from '@/domain/wallet/wallet';
import { makeTransaction, makeWallet, NOW } from './factories';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function settle(transaction: WagerTransaction, wallet: Wallet, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  return WagerSettlement.settle(transaction, wallet, { reference, referenceAlreadyReversed, now: NOW });
}

function processedBet(wallet: Wallet, amount = '25.00'): WagerTransaction {
  const bet = makeTransaction({ kind: WagerTransactionKind.Bet, externalTransactionId: `bet-${crypto.randomUUID()}`, money: brl(amount) });
  settle(bet, wallet);
  return bet;
}

describe('WagerSettlement', () => {
  describe('BET', () => {
    it('debits the wallet and records one DEBIT entry', () => {
      const wallet = makeWallet('100.00');
      const bet = makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('25.00') });

      const entry = settle(bet, wallet);

      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe('75.00');
      expect(bet.observedBalance?.toString()).toBe('75.00');
    });

    it('is rejected with INSUFFICIENT_FUNDS and leaves no entry', () => {
      const wallet = makeWallet('100.00');
      const bet = makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('100.01') });

      const entry = settle(bet, wallet);

      expect(entry).toBeUndefined();
      expect(bet.status).toBe(WagerTransactionStatus.Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('two bets of 80.00 over 100.00: only the first one goes through', () => {
      const wallet = makeWallet('100.00');
      const first = makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('80.00') });
      const second = makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('80.00') });

      settle(first, wallet);
      settle(second, wallet);

      expect(first.status).toBe(WagerTransactionStatus.Processed);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toString()).toBe('20.00');
    });
  });

  describe('WIN', () => {
    it('credits the wallet without a reference', () => {
      const wallet = makeWallet('10.00');
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('50.00') });

      const entry = settle(win, wallet);

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toString()).toBe('60.00');
    });

    it('may reference the BET of the same round', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet);
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });

      settle(win, wallet, bet);

      expect(win.status).toBe(WagerTransactionStatus.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toString()).toBe('115.00');
    });
  });

  describe('LOSS', () => {
    it('is processed without moving the balance or producing an entry', () => {
      const wallet = makeWallet('100.00');
      const loss = makeTransaction({ kind: WagerTransactionKind.Loss, money: brl('0.00') });

      const entry = settle(loss, wallet);

      expect(entry).toBeUndefined();
      expect(loss.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet, '30.00');
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId });

      const entry = settle(refund, wallet, bet);

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('only references BET', () => {
      const wallet = makeWallet('100.00');
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('30.00') });
      settle(win, wallet);
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('30.00'), referenceExternalTransactionId: win.externalTransactionId });

      settle(refund, wallet, win);

      expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('requires the same amount as the reference', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet, '30.00');
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('10.00'), referenceExternalTransactionId: bet.externalTransactionId });

      settle(refund, wallet, bet);

      expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
    });

    it('cannot reverse the same BET twice', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet, '30.00');
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId });

      settle(refund, wallet, bet, true);

      expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(wallet.balance.toString()).toBe('70.00');
    });

    it('waits when the reference has not arrived yet', () => {
      const wallet = makeWallet('100.00');
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('30.00'), referenceExternalTransactionId: 'bet-from-the-future' });

      const entry = settle(refund, wallet);

      expect(entry).toBeUndefined();
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
    });

    it('is rejected when the reference was rejected', () => {
      const wallet = makeWallet('10.00');
      const bet = makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('30.00') });
      settle(bet, wallet);
      const refund = makeTransaction({ kind: WagerTransactionKind.Refund, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId });

      settle(refund, wallet, bet);

      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });

    it('is rejected when the reference belongs to another round', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet, '30.00');
      const refund = makeTransaction({
        kind: WagerTransactionKind.Refund,
        money: brl('30.00'),
        roundId: 'another-round',
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      settle(refund, wallet, bet);

      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('ROLLBACK', () => {
    it('reverses a BET with a CREDIT', () => {
      const wallet = makeWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });

      const entry = settle(rollback, wallet, bet);

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('reverses a WIN with a DEBIT', () => {
      const wallet = makeWallet('100.00');
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('50.00') });
      settle(win, wallet);
      const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId });

      const entry = settle(rollback, wallet, win);

      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('rejects a reversal that would make the balance negative with its own failure code', () => {
      const wallet = makeWallet('0.00');
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('50.00') });
      settle(win, wallet);
      wallet.debit(brl('45.00'), 'some-bet', NOW);
      const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId });

      settle(rollback, wallet, win);

      expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(wallet.balance.toString()).toBe('5.00');
    });

    it('does not reverse a LOSS', () => {
      const wallet = makeWallet('100.00');
      const loss = makeTransaction({ kind: WagerTransactionKind.Loss, money: brl('10.00') });
      settle(loss, wallet);
      const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, money: brl('10.00'), referenceExternalTransactionId: loss.externalTransactionId });

      settle(rollback, wallet, loss);

      expect(rollback.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('waits while the referenced transaction is itself waiting for a reference', () => {
      const wallet = makeWallet('100.00');
      const win = makeTransaction({ kind: WagerTransactionKind.Win, money: brl('10.00'), referenceExternalTransactionId: 'unknown-bet' });
      settle(win, wallet);
      const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, money: brl('10.00'), referenceExternalTransactionId: win.externalTransactionId });

      settle(rollback, wallet, win);

      expect(win.status).toBe(WagerTransactionStatus.PendingReference);
      expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    });
  });

  describe('wallet ownership', () => {
    it('rejects a currency that differs from the wallet', () => {
      const wallet = makeWallet('100.00');
      const bet = makeTransaction({ kind: WagerTransactionKind.Bet, money: Money.from({ amount: '10.00', currency: 'USD' }) });

      settle(bet, wallet);

      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('rejects a player that does not own the wallet', () => {
      const wallet = makeWallet('100.00');
      const bet = makeTransaction({ kind: WagerTransactionKind.Bet, playerId: 'someone-else' });

      settle(bet, wallet);

      expect(bet.failureCode).toBe(FailureCode.PlayerMismatch);
    });
  });
});
