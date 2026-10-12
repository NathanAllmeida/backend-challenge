import { Money } from '@/domain/money/money';
import { CreateWagerTransactionProps, WagerTransaction } from '@/domain/wager/wager-transaction';
import { WagerTransactionKind } from '@/domain/wager/wager-transaction-kind';
import { Wallet } from '@/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');

let sequence = 0;

export function makeWallet(amount = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount, currency }),
    openedAt: NOW,
  });
}

export function makeTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${sequence}`;

  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: `hash-${sequence}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: NOW,
    ...overrides,
  });
}
