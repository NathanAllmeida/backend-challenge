import { Injectable } from '@nestjs/common';
import { InvalidRequestError, ResourceNotFoundError } from '../errors/application.error';
import { LedgerRepository, WalletRepository } from '../ports/repositories';
import { LedgerPageView, toLedgerEntryView, toWalletView, WalletView } from './wallet.views';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

@Injectable()
export class WalletQueries {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async findWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);

    if (!wallet) {
      throw new ResourceNotFoundError(`Wallet ${walletId} not found`);
    }

    return toWalletView(wallet);
  }

  async ledgerPage(walletId: string, cursor: string | undefined, limit = LEDGER_DEFAULT_LIMIT): Promise<LedgerPageView> {
    await this.findWallet(walletId);

    const afterPosition = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.ledger.page(walletId, afterPosition, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      walletId,
      items: page.map((row) => toLedgerEntryView(row.entry)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.position) : null,
    };
  }
}

export function encodeCursor(position: string): string {
  return Buffer.from(JSON.stringify({ p: position }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const position = parseCursor(cursor);

  if (!position) {
    throw new InvalidRequestError('Invalid ledger cursor');
  }

  return position;
}

function parseCursor(cursor: string): string | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { p?: unknown };
    return typeof decoded.p === 'string' && /^\d+$/.test(decoded.p) ? decoded.p : undefined;
  } catch {
    return undefined;
  }
}
