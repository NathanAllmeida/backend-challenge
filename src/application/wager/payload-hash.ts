import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money';
import { SubmitWagerCommand } from './submit-wager.command';

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

export function canonicalJson(value: Canonical): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function wagerPayloadHash(command: SubmitWagerCommand): string {
  const money = Money.from(command.money);

  const businessFields: Canonical = {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: money.toString(), currency: money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
  };

  return sha256(canonicalJson(businessFields));
}
