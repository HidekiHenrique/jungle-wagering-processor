import type { AddressInfo } from 'node:net';
import { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { configureHttpApp } from '../../../src/presentation/configure-http-app';

export interface HttpTestApp {
  baseUrl: string;
  request(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpReply>;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` while another transaction holds `SELECT ... FOR UPDATE` on that row. */
  withRowLock<T>(table: string, id: string, fn: () => Promise<T>): Promise<T>;
  /** Any provider of the application (use cases, consumer, relay, ...). */
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

export interface HttpReply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: tests assert on arbitrary JSON bodies
  body: any;
}

/** Boots the real HTTP application (same pipeline as main.ts) on a random port. */
export async function createHttpTestApp(): Promise<HttpTestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureHttpApp(moduleRef.createNestApplication({ logger: false }));
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;

  const orm = moduleRef.get(MikroORM) as unknown as MikroORM;
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async request(method, path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...options.headers },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text ? JSON.parse(text) : undefined,
      };
    },
    sql: (query, params = []) => orm.em.fork().getConnection().execute(query, params) as never,
    withRowLock: (table, id, fn) =>
      orm.em.fork().transactional(async (em) => {
        await em.execute(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
        return fn();
      }),
    get: <T>(token: unknown) => moduleRef.get(token as never) as T,
    close: () => app.close(),
  };
}
