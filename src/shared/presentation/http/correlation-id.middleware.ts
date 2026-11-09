import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '../../infrastructure/logger/log-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Opens a LogContext for each HTTP request. Reuses the caller's X-Correlation-Id when it is
 * well-formed (so a provider can trace its own request) and generates one otherwise.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_ID_HEADER);
    const correlationId = incoming && VALID_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    runWithLogContext({ correlationId }, next);
  }
}
