import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApplicationError } from '../../application/application-error';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const MAX_LENGTH = 255;

export class InvalidIdempotencyKeyError extends ApplicationError {
  readonly code = 'INVALID_IDEMPOTENCY_KEY';

  constructor(reason: string) {
    super(`Idempotency-Key header ${reason}`);
  }
}

/**
 * Reads the mandatory `Idempotency-Key` header. It is the source of truth for idempotency:
 * the body is only used to detect a key reused with a different payload.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!value) throw new InvalidIdempotencyKeyError('is required');
  if (value.length > MAX_LENGTH)
    throw new InvalidIdempotencyKeyError(`must have at most ${MAX_LENGTH} characters`);
  return value;
});
