import { describe, expect, it } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../../src/shared/infrastructure/config/app-config';

const validEnv = {
  NODE_ENV: 'test',
  HTTP_PORT: '3000',
  LOG_LEVEL: 'info',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'db',
  DB_POOL_MAX: '10',
  DB_LOCK_TIMEOUT_MS: '5000',
  PENDING_REFERENCE_BASE_DELAY_MS: '2000',
  PENDING_REFERENCE_MAX_DELAY_MS: '300000',
  PENDING_REFERENCE_MAX_ATTEMPTS: '10',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_REGION: 'us-east-1',
  SQS_ACCESS_KEY_ID: 'test',
  SQS_SECRET_ACCESS_KEY: 'test',
  SQS_WAGER_QUEUE: 'wager-transactions.fifo',
  SQS_WAGER_DLQ: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'wallet-events.fifo',
};

describe('loadConfig', () => {
  it('parses a valid environment into typed config', () => {
    const config = loadConfig(validEnv);
    expect(config.http.port).toBe(3000);
    expect(config.database.poolMax).toBe(10);
    expect(config.sqs.wagerQueue).toBe('wager-transactions.fifo');
  });

  it('reports every problem at once instead of failing on the first', () => {
    const env = { ...validEnv, DB_HOST: '', HTTP_PORT: '30.5', LOG_LEVEL: 'loud' };
    try {
      loadConfig(env);
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).problems).toEqual([
        'HTTP_PORT must be an integer, got "30.5"',
        'LOG_LEVEL must be one of fatal, error, warn, info, debug, verbose, got "loud"',
        'DB_HOST is required',
      ]);
    }
  });

  it('requires the query timeout to exceed the lock timeout', () => {
    expect(() =>
      loadConfig({ ...validEnv, DB_LOCK_TIMEOUT_MS: '5000', DB_QUERY_TIMEOUT_MS: '5000' }),
    ).toThrow('DB_QUERY_TIMEOUT_MS must be greater than DB_LOCK_TIMEOUT_MS');
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ ...validEnv, DB_PORT: '70000' })).toThrow(
      'DB_PORT must be between 1 and 65535',
    );
  });
});
