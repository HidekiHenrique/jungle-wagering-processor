import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../../shared/presentation/http/money.dto';
import { PROVIDER_KINDS } from '../../domain/wager-transaction-kind';

const ID = [1, 128] as const;

export class SubmitWagerTransactionDto {
  @IsString()
  @Length(...ID)
  providerId!: string;

  @IsString()
  @Length(...ID)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(...ID)
  roundId!: string;

  @IsString()
  @Length(...ID)
  gameId!: string;

  /** OPENING is not in the list: it can never be submitted (400). */
  @IsIn(PROVIDER_KINDS)
  kind!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @Length(...ID)
  referenceExternalTransactionId?: string;
}

export class OpenWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
