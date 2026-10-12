import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError } from '@/domain/errors/domain.error';
import { Money } from '@/domain/money/money';
import { LedgerDirection } from '@/domain/wallet/ledger-direction';
import { Wallet } from '@/domain/wallet/wallet';
import { WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');

const openWallet = (amount = '100.00') => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(amount), openedAt: now });

describe('Wallet', () => {
  it('opens with version 1 and the currency of the initial balance', () => {
    const wallet = openWallet('100.00');

    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('produces an opening credit entry only when the initial balance is positive', () => {
    expect(openWallet('0.00').openingEntry('tx-0')).toBeUndefined();

    const entry = openWallet('100.00').openingEntry('tx-0');
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.balanceAfter.toString()).toBe('100.00');
  });

  it('debits and returns a balanced ledger entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('80.00'), 'tx-1', now);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits and increments the version', () => {
    const wallet = openWallet('20.00');
    wallet.credit(brl('5.50'), 'tx-2', now);

    expect(wallet.balance.toString()).toBe('25.50');
    expect(wallet.version).toBe(2);
  });

  it('never lets the balance go negative', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), 'tx-1', now);

    expect(() => wallet.debit(brl('80.00'), 'tx-2', now)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('allows debiting the whole balance', () => {
    const wallet = openWallet('10.00');
    wallet.debit(brl('10.00'), 'tx-1', now);

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejects operations in another currency without touching state', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => wallet.credit(usd, 'tx-1', now)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, 'tx-1', now)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rehydrates without revalidating', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('42.00');
  });
});

describe('WalletLedgerEntry', () => {
  it('validates the arithmetic on create', () => {
    expect(() => WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('16.00'),
      createdAt: now,
    })).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects zero amount entries', () => {
    expect(() => WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: brl('0.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('5.00'),
      createdAt: now,
    })).toThrow(UnbalancedLedgerEntryError);
  });

  it('is structurally immutable', () => {
    const entry = openWallet('100.00').openingEntry('tx-0')!;

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletId: string }).walletId = 'other';
    }).toThrow();
  });
});
