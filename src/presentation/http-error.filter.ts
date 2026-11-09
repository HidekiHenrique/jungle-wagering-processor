import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../shared/application/application-error';
import { DomainError } from '../shared/domain/domain-error';
import { isTransientInfrastructureError } from '../shared/infrastructure/database/transient-error';
import { currentLogContext } from '../shared/infrastructure/logger/log-context';

/**
 * Error code → HTTP status, for the whole API. It lives at the composition root (next to
 * AppModule) because it is the one place allowed to know every module's errors.
 *
 *   400 the request can never succeed as sent      → fix it
 *   404 the resource does not exist
 *   409 conflicts with an existing operation        → do not resend this key/payload pair
 *   422 rejected by a business rule                 → final for this key
 *   503 transient infrastructure failure            → resend the same request later (Retry-After)
 *   500 bug                                          → nothing the client can do
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_MONEY: 400,
  INVALID_WAGER_TRANSACTION: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_CURSOR: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
};

const RETRY_AFTER_SECONDS = '1';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  correlationId?: string;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toHttp(exception);
    const correlationId = currentLogContext().correlationId;

    if (status === 503) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    if (status >= 500) {
      this.logger.error({ msg: 'Request failed', status, code: body.error.code, error: describe(exception) });
    }
    response.status(status).json({ ...body, ...(correlationId ? { correlationId } : {}) });
  }

  private toHttp(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApplicationError || exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? (exception instanceof DomainError ? 422 : 400);
      return { status, body: { error: { code: exception.code, message: exception.message } } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse() as { message?: unknown } | string;
      const details = typeof payload === 'object' ? payload.message : undefined;
      const code =
        status === 400
          ? 'INVALID_PAYLOAD'
          : status === 404
            ? 'NOT_FOUND'
            : status === 401
              ? 'UNAUTHORIZED'
              : 'HTTP_ERROR';
      return {
        status,
        body: { error: { code, message: exception.message, ...(Array.isArray(details) ? { details } : {}) } },
      };
    }
    if (isTransientInfrastructureError(exception)) {
      return {
        status: 503,
        body: {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporary failure, retry the same request' },
        },
      };
    }
    return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } } };
  }
}

function describe(exception: unknown) {
  return exception instanceof Error
    ? { name: exception.name, message: exception.message, stack: exception.stack }
    : { value: String(exception) };
}
