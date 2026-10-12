import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '@/domain/events/wager-events';
import { InvalidTransactionStateError } from '@/domain/errors/domain.error';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { makeWallet, NOW } from './factories';

function balanceChangedEvent(): WalletBalanceChanged {
  const wallet = makeWallet('100.00');
  const entry = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), 'tx-1', NOW);

  return WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW });
}

describe('IntegrationEvent', () => {
  it('keeps eventType and version on the type and serializes money as decimal strings', () => {
    const json = balanceChangedEvent().toJSON();

    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('msg-1');
    expect(json.data as unknown).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

describe('OutboxMessage', () => {
  it('is enqueued as pending and due immediately', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.payload.eventType).toBe('WalletBalanceChanged');
  });

  it('backs off exponentially up to a ceiling', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    const delays: number[] = [];

    for (let i = 0; i < 10; i++) {
      message.scheduleRetry(NOW, 'boom');
      delays.push(message.nextAttemptAt!.getTime() - NOW.getTime());
    }

    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(delays.at(-1)).toBe(OutboxMessage.MAX_RETRY_DELAY_MS);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.lastError).toBe('boom');
  });

  it('stops being due once published', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
  });
});

describe('InboxMessage', () => {
  it('can only be marked as processed once', () => {
    const message = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'consumer', payloadHash: 'h', receivedAt: NOW });

    message.markProcessed(NOW);

    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});
