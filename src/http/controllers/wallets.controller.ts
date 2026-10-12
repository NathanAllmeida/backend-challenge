import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { InvalidRequestError } from '../../application/errors/application.error';
import { OpenWallet } from '../../application/wallet/open-wallet.use-case';
import { ReconcileWallet } from '../../application/wallet/reconcile-wallet.use-case';
import { LEDGER_DEFAULT_LIMIT, LEDGER_MAX_LIMIT, WalletQueries } from '../../application/wallet/wallet-queries';
import { LedgerPageView, ReconciliationView, WalletView } from '../../application/wallet/wallet.views';
import { UUID_PATTERN } from '../../contracts/money.contract';
import { validateContract } from '../../contracts/validate-contract';
import { OpenWalletContract } from '../../contracts/wallet.contract';
import { LogContext } from '../../infrastructure/observability/log-context';
import { correlationIdOf } from '../correlation.middleware';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const input = validateContract(OpenWalletContract, body);
    const wallet = await this.openWallet.execute(input, correlationIdOf(request));

    LogContext.enrich({ walletId: wallet.id });
    return wallet;
  }

  @Get(':walletId')
  show(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.findWallet(assertUuid(walletId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPageView> {
    return this.queries.ledgerPage(assertUuid(walletId), cursor || undefined, parseLimit(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(assertUuid(walletId));
  }
}

export function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`"${value}" is not a valid id`);
  }

  return value;
}

function parseLimit(limit: string | undefined): number {
  if (limit === undefined || limit === '') {
    return LEDGER_DEFAULT_LIMIT;
  }

  const parsed = Number(limit);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > LEDGER_MAX_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`);
  }

  return parsed;
}
