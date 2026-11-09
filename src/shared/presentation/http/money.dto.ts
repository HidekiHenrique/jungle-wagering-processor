import { IsString } from 'class-validator';

/**
 * Shape check only (strings, not numbers). The exact rules (scale, sign, currency code) live in
 * Money.from, so they are enforced identically for HTTP, SQS and internal callers.
 */
export class MoneyDto {
  @IsString()
  amount!: string;

  @IsString()
  currency!: string;
}
