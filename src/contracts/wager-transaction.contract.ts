import { Type } from 'class-transformer';
import { Equals, IsDefined, IsIn, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { SubmitWagerCommand } from '../application/wager/submit-wager.command';
import { SUBMITTABLE_KINDS, WagerTransactionKind } from '../domain/wager/wager-transaction-kind';
import { MoneyContract, UUID_PATTERN } from './money.contract';

export class WagerTransactionContract {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  playerId!: string;

  @IsString()
  @Matches(UUID_PATTERN, { message: 'walletId must be a UUID' })
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS, { message: `kind must be one of ${SUBMITTABLE_KINDS.join(', ')}` })
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyContract)
  money!: MoneyContract;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  referenceExternalTransactionId?: string;

  toCommand(idempotencyKey: string): SubmitWagerCommand {
    return {
      idempotencyKey,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      playerId: this.playerId,
      walletId: this.walletId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: { amount: this.money.amount, currency: this.money.currency },
      referenceExternalTransactionId: this.referenceExternalTransactionId,
    };
  }
}

export class WagerTransactionMessageData extends WagerTransactionContract {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey!: string;
}

export class WagerTransactionRequestedMessage {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WagerTransactionMessageData)
  data!: WagerTransactionMessageData;
}
