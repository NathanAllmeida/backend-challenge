import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidRequestError } from '../../application/errors/application.error';
import { SubmitWagerTransaction } from '../../application/wager/submit-wager-transaction.use-case';
import { WagerTransactionResult } from '../../application/wager/submit-wager.command';
import { WagerQueries, WagerTransactionView } from '../../application/wager/wager-queries';
import { validateContract } from '../../contracts/validate-contract';
import { WagerTransactionContract } from '../../contracts/wager-transaction.contract';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { LogContext } from '../../infrastructure/observability/log-context';
import { correlationIdOf } from '../correlation.middleware';
import { assertUuid } from './wallets.controller';

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

@Controller()
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerTransaction,
    private readonly queries: WagerQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const key = this.requireIdempotencyKey(idempotencyKey);
    const input = validateContract(WagerTransactionContract, body);

    LogContext.enrich({ walletId: input.walletId, providerId: input.providerId });

    const result = await this.submitWager.execute(input.toCommand(key), {
      source: 'http',
      correlationId: correlationIdOf(request),
      causationId: key,
    });

    LogContext.enrich({ transactionId: result.transactionId });
    response.status(statusFor(result)).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  show(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.queries.findById(assertUuid(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  showByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.findByExternalId(providerId, externalTransactionId);
  }

  private requireIdempotencyKey(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();

    if (!key) {
      throw new InvalidRequestError('Idempotency-Key header is required');
    }

    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new InvalidRequestError(`Idempotency-Key must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }

    return key;
  }
}

function statusFor(result: WagerTransactionResult): HttpStatus {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
