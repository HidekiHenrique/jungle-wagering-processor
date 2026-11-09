export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly http: { readonly port: number };
  readonly log: { readonly level: LogLevel };
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly name: string;
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
    /** Max time to get a connection (new or from the pool). */
    readonly connectTimeoutMs: number;
    /** Max time for any single query, enforced by the client: covers a server that stops answering. */
    readonly queryTimeoutMs: number;
  };
  readonly pendingReference: {
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly wagerQueue: string;
    readonly wagerDlq: string;
    readonly eventsQueue: string;
    /** Long-polling wait per ReceiveMessage (0-20s). */
    readonly waitTimeSeconds: number;
    /** Backoff for transient failures: visibility = min(base * 2^(receiveCount-1), max). */
    readonly retryBaseDelaySeconds: number;
    readonly retryMaxDelaySeconds: number;
  };
  readonly workers: {
    readonly consumerEnabled: boolean;
    readonly outboxRelayEnabled: boolean;
    readonly outboxPollIntervalMs: number;
    readonly outboxBatchSize: number;
    readonly pendingReferenceEnabled: boolean;
    readonly pendingReferencePollIntervalMs: number;
    readonly pendingReferenceBatchSize: number;
    /** Max time to finish in-flight work on SIGTERM before giving messages back. */
    readonly shutdownTimeoutMs: number;
  };
}

/** Injection token. AppConfig is an interface, so it has no runtime value to inject by type. */
export const APP_CONFIG = Symbol('APP_CONFIG');

export class InvalidConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads and validates environment variables once, at startup.
 * Collects every problem before failing, so a broken deploy reports all of them at once.
 */
export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const str = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
      problems.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const int = (key: string, min: number, max: number): number => {
    const raw = str(key);
    if (!raw) return 0;
    if (!/^\d+$/.test(raw)) {
      problems.push(`${key} must be an integer, got "${raw}"`);
      return 0;
    }
    const value = Number(raw);
    if (value < min || value > max) problems.push(`${key} must be between ${min} and ${max}`);
    return value;
  };

  /** Operational knobs have safe defaults; connection settings do not. */
  const intOr = (key: string, fallback: number, min: number, max: number): number =>
    env[key]?.trim() ? int(key, min, max) : fallback;

  const boolOr = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    if (raw !== 'true' && raw !== 'false') problems.push(`${key} must be true or false, got "${raw}"`);
    return raw === 'true';
  };

  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T => {
    const raw = str(key);
    if (raw && !(allowed as readonly string[]).includes(raw)) {
      problems.push(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
    }
    return raw as T;
  };

  const config: AppConfig = {
    nodeEnv: oneOf('NODE_ENV', NODE_ENVS),
    http: { port: int('HTTP_PORT', 1, 65535) },
    log: { level: oneOf('LOG_LEVEL', LOG_LEVELS) },
    database: {
      host: str('DB_HOST'),
      port: int('DB_PORT', 1, 65535),
      user: str('DB_USER'),
      password: str('DB_PASSWORD'),
      name: str('DB_NAME'),
      poolMax: int('DB_POOL_MAX', 1, 200),
      lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 1, 60_000),
      connectTimeoutMs: intOr('DB_CONNECT_TIMEOUT_MS', 5_000, 100, 60_000),
      queryTimeoutMs: intOr('DB_QUERY_TIMEOUT_MS', 15_000, 100, 300_000),
    },
    pendingReference: {
      baseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 1, 3_600_000),
      maxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 1, 86_400_000),
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 1, 1_000),
    },
    sqs: {
      endpoint: str('SQS_ENDPOINT'),
      region: str('SQS_REGION'),
      accessKeyId: str('SQS_ACCESS_KEY_ID'),
      secretAccessKey: str('SQS_SECRET_ACCESS_KEY'),
      wagerQueue: str('SQS_WAGER_QUEUE'),
      wagerDlq: str('SQS_WAGER_DLQ'),
      eventsQueue: str('SQS_EVENTS_QUEUE'),
      waitTimeSeconds: intOr('SQS_WAIT_TIME_SECONDS', 10, 0, 20),
      retryBaseDelaySeconds: intOr('SQS_RETRY_BASE_DELAY_SECONDS', 1, 1, 900),
      retryMaxDelaySeconds: intOr('SQS_RETRY_MAX_DELAY_SECONDS', 60, 1, 43_200),
    },
    workers: {
      consumerEnabled: boolOr('SQS_CONSUMER_ENABLED', true),
      outboxRelayEnabled: boolOr('OUTBOX_RELAY_ENABLED', true),
      outboxPollIntervalMs: intOr('OUTBOX_POLL_INTERVAL_MS', 500, 10, 60_000),
      outboxBatchSize: intOr('OUTBOX_BATCH_SIZE', 50, 1, 500),
      pendingReferenceEnabled: boolOr('PENDING_REFERENCE_WORKER_ENABLED', true),
      pendingReferencePollIntervalMs: intOr('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000, 10, 60_000),
      pendingReferenceBatchSize: intOr('PENDING_REFERENCE_BATCH_SIZE', 50, 1, 500),
      shutdownTimeoutMs: intOr('SHUTDOWN_TIMEOUT_MS', 20_000, 100, 120_000),
    },
  };

  if (config.database.queryTimeoutMs <= config.database.lockTimeoutMs) {
    problems.push('DB_QUERY_TIMEOUT_MS must be greater than DB_LOCK_TIMEOUT_MS (a lock wait is a query)');
  }
  if (problems.length > 0) throw new InvalidConfigError(problems);
  return config;
}
