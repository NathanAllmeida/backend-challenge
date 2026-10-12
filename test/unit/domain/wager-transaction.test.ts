import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/domain/errors/domain.error';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wager/failure-code';
import { ReferenceRetryPolicy } from '@/domain/wager/reference-retry-policy';
import { WagerTransaction } from '@/domain/wager/wager-transaction';
import { WagerTransactionKind } from '@/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '@/domain/wager/wager-transaction-status';
import { LedgerDirection } from '@/domain/wallet/ledger-direction';
import { makeTransaction } from './factories';

const now = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    const transaction = makeTransaction({ kind: WagerTransactionKind.Bet });

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  it('cannot be created as OPENING from the outside', () => {
    expect(() => makeTransaction({ kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s requires a reference', (kind) => {
    expect(() => makeTransaction({ kind, referenceExternalTransactionId: undefined })).toThrow(InvalidWagerTransactionError);
  });

  it('cannot reference itself', () => {
    expect(() => makeTransaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'tx-1',
      referenceExternalTransactionId: 'tx-1',
    })).toThrow(InvalidWagerTransactionError);
  });

  it('requires a positive amount except for LOSS', () => {
    expect(() => makeTransaction({ kind: WagerTransactionKind.Bet, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(makeTransaction({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).money.isZero()).toBe(true);
  });

  it('PROCESSED, REJECTED and FAILED are terminal', () => {
    const processed = makeTransaction({ kind: WagerTransactionKind.Bet });
    processed.markProcessed(undefined, now, brl('10.00'));

    const rejected = makeTransaction({ kind: WagerTransactionKind.Bet });
    rejected.reject(FailureCode.InsufficientFunds, now, brl('10.00'));

    const failed = makeTransaction({ kind: WagerTransactionKind.Bet });
    failed.fail(FailureCode.ProcessingError, now);

    for (const transaction of [processed, rejected, failed]) {
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed(undefined, now, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.markPendingReference(now, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.reject(FailureCode.AmountMismatch, now, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.fail(FailureCode.ProcessingError, now)).toThrow(InvalidTransactionStateError);
    }
  });

  it('PENDING_REFERENCE can be retried with exponential backoff and then resolved', () => {
    const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });

    rollback.markPendingReference(now, brl('10.00'));
    expect(rollback.referenceAttempts).toBe(1);
    expect(rollback.nextReferenceCheckAt?.getTime()).toBe(now.getTime() + 2_000);

    rollback.markPendingReference(now, brl('10.00'));
    expect(rollback.nextReferenceCheckAt?.getTime()).toBe(now.getTime() + 4_000);

    rollback.markProcessed('reference-id', now, brl('20.00'));
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.referenceTransactionId).toBe('reference-id');
    expect(rollback.nextReferenceCheckAt).toBeUndefined();
  });

  it('caps the reference backoff and knows when attempts are exhausted', () => {
    const transaction = makeTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });

    for (let attempt = 1; attempt <= ReferenceRetryPolicy.MAX_ATTEMPTS; attempt++) {
      transaction.markPendingReference(now, brl('0.00'));
    }

    expect(transaction.hasExhaustedReferenceAttempts()).toBe(true);
    expect(transaction.nextReferenceCheckAt!.getTime() - now.getTime()).toBe(ReferenceRetryPolicy.MAX_DELAY_MS);
  });

  it('matches payloads by hash', () => {
    const transaction = makeTransaction({ payloadHash: 'abc' });

    expect(transaction.matchesPayload('abc')).toBe(true);
    expect(transaction.matchesPayload('abd')).toBe(false);
  });

  it('knows which kinds move the balance and in which direction', () => {
    const bet = makeTransaction({ kind: WagerTransactionKind.Bet });
    const win = makeTransaction({ kind: WagerTransactionKind.Win });
    const loss = makeTransaction({ kind: WagerTransactionKind.Loss });
    const refund = makeTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    const rollback = makeTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });

    expect(loss.affectsBalance()).toBe(false);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('builds the internal OPENING transaction', () => {
    const opening = WagerTransaction.opening({ walletId: 'w-1', playerId: 'p-1', money: brl('100.00'), payloadHash: 'h', at: now });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.providerId).toBe('internal');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
