import { IsString, Matches } from 'class-validator';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MoneyContract {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a non-negative decimal string with up to 2 decimal places' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
}
