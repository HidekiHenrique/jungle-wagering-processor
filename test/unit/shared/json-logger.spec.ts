import { describe, expect, it } from 'bun:test';
import { JsonLogger } from '../../../src/shared/infrastructure/logger/json-logger';
import { enrichLogContext, runWithLogContext } from '../../../src/shared/infrastructure/logger/log-context';

function capture(level: ConstructorParameters<typeof JsonLogger>[0] = 'verbose') {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(level, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('writes one JSON object per call with level, context and message', () => {
    const { logger, lines } = capture();
    logger.log('started', 'Bootstrap');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', context: 'Bootstrap', message: 'started' });
    expect(typeof lines[0]?.timestamp).toBe('string');
  });

  it('merges structured fields passed as an object', () => {
    const { logger, lines } = capture();
    logger.warn({ msg: 'retrying', attempt: 2 }, 'Worker');
    expect(lines[0]).toMatchObject({ level: 'warn', message: 'retrying', attempt: 2, context: 'Worker' });
  });

  it('attaches identifiers from the current log context, including ones added mid-flow', async () => {
    const { logger, lines } = capture();
    await runWithLogContext({ correlationId: 'corr-1' }, async () => {
      await Promise.resolve();
      enrichLogContext({ walletId: 'w-1', providerId: 'provider-a' });
      logger.log('processing');
    });
    logger.log('outside');
    expect(lines[0]).toMatchObject({ correlationId: 'corr-1', walletId: 'w-1', providerId: 'provider-a' });
    expect(lines[1]).not.toHaveProperty('correlationId');
  });

  it('keeps contexts of concurrent flows isolated', async () => {
    const { logger, lines } = capture();
    const flow = (id: string, delay: number) =>
      runWithLogContext({ correlationId: id }, async () => {
        await Bun.sleep(delay);
        logger.log(id);
      });
    await Promise.all([flow('a', 10), flow('b', 0)]);
    for (const line of lines) expect(line.correlationId).toBe(line.message);
  });

  it('redacts sensitive keys at any depth', () => {
    const { logger, lines } = capture();
    logger.log({ msg: 'request', headers: { authorization: 'Bearer x', 'x-api-key': 'k' }, password: 'p' });
    expect(lines[0]).toMatchObject({
      headers: { authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      password: '[REDACTED]',
    });
  });

  it('separates stack trace from context in error()', () => {
    const { logger, lines } = capture();
    logger.error('boom', 'Error: boom\n    at x', 'Consumer');
    expect(lines[0]).toMatchObject({ level: 'error', message: 'boom', context: 'Consumer' });
    expect(lines[0]?.stack).toContain('at x');
  });

  it('drops messages below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.log('info is hidden');
    logger.debug('debug is hidden');
    logger.error('error is shown');
    expect(lines.map((l) => l.message)).toEqual(['error is shown']);
  });
});
