import { Type } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, MaxLength, ValidateNested } from 'class-validator';
import { MoneyContract } from './money.contract';

export class OpenWalletContract {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyContract)
  initialBalance!: MoneyContract;
}
