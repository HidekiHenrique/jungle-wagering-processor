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
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly wagerQueue: string;
    readonly wagerDlq: string;
    readonly eventsQueue: string;
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
    },
    sqs: {
      endpoint: str('SQS_ENDPOINT'),
      region: str('SQS_REGION'),
      accessKeyId: str('SQS_ACCESS_KEY_ID'),
      secretAccessKey: str('SQS_SECRET_ACCESS_KEY'),
      wagerQueue: str('SQS_WAGER_QUEUE'),
      wagerDlq: str('SQS_WAGER_DLQ'),
      eventsQueue: str('SQS_EVENTS_QUEUE'),
    },
  };

  if (problems.length > 0) throw new InvalidConfigError(problems);
  return config;
}
