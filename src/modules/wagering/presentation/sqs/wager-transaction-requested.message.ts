import { Type } from 'class-transformer';
import { Equals, IsDefined, IsISO8601, IsString, Length, ValidateNested } from 'class-validator';
import { SubmitWagerTransactionDto } from '../http/wager-transaction.dto';

/** `data` of the queue message: the HTTP payload plus the idempotency key (no headers on a queue). */
export class WagerTransactionRequestedData extends SubmitWagerTransactionDto {
  @IsString()
  @Length(1, 255)
  idempotencyKey!: string;
}

/** Message contract of `wager-transactions.fifo` (challenge §10). */
export class WagerTransactionRequestedMessage {
  /** Producer-assigned id, stable across redeliveries: the inbox key. */
  @IsString()
  @Length(1, 128)
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerTransactionRequestedData)
  data!: WagerTransactionRequestedData;
}
