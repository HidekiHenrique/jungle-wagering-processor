import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../config/app-config';
import { currentLogContext } from './log-context';

const SEVERITY: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  verbose: 5,
};

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key/i;

type Sink = (line: string) => void;
type Fields = Record<string, unknown>;

/**
 * NestJS LoggerService that writes one JSON object per line to stdout.
 *
 * Application code keeps using Nest's `new Logger(Context.name)`; Nest routes those calls here.
 * Every line carries the identifiers from the current LogContext (correlationId, walletId, ...).
 * Structured fields can be logged by passing an object: `logger.log({ msg: '...', attempt: 2 })`.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(
    level: LogLevel,
    private readonly sink: Sink = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.threshold = SEVERITY[level];
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: LogLevel, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] > this.threshold) return;

    // Nest convention: the last string parameter is the context (class name);
    // for error(), a preceding string is the stack trace.
    const strings = params.filter((p): p is string => typeof p === 'string');
    const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;

    const entry: Fields = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...currentLogContext(),
      ...this.normalizeMessage(message),
      ...(stack ? { stack } : {}),
    };

    this.sink(JSON.stringify(redact(entry)));
  }

  private normalizeMessage(message: unknown): Fields {
    if (message instanceof Error) {
      return { message: message.message, errorName: message.name, stack: message.stack };
    }
    if (typeof message === 'object' && message !== null) {
      const { msg, message: text, ...fields } = message as Fields;
      return { message: msg ?? text ?? '', ...fields };
    }
    return { message: String(message) };
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const out: Fields = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(inner);
  }
  return out;
}
