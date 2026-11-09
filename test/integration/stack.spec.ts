import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { createSqsClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-client.factory';
import { loadConfig } from '../../src/shared/infrastructure/config/app-config';
import { buildOrmOptions } from '../../src/shared/infrastructure/database/mikro-orm.config';

/**
 * Stage 1 exit criteria: the real stack (Bun + Nest + MikroORM + Postgres + SQS emulator)
 * works end to end. Requires `bun run infra:up`.
 */
const config = loadConfig(process.env);

describe('stack: configuration', () => {
  it('runs tests against the isolated test database', () => {
    expect(config.nodeEnv).toBe('test');
    expect(config.database.name).toBe('wagering_test');
  });
});

describe('stack: PostgreSQL migrations', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(buildOrmOptions(config));
  });

  afterAll(async () => {
    await orm.close();
  });

  const baselineFunctionExists = async () => {
    const rows = await orm.em
      .fork()
      .getConnection()
      .execute<{ count: string }[]>(
        `SELECT count(*) AS count FROM pg_proc WHERE proname = 'forbid_mutation'`,
      );
    return rows[0]?.count === '1';
  };

  it('reverts every migration and re-applies them (up → down → up)', async () => {
    await orm.migrator.up();
    expect(await baselineFunctionExists()).toBe(true);

    await orm.migrator.down({ to: 0 });
    expect(await orm.migrator.getExecuted()).toHaveLength(0);
    expect(await baselineFunctionExists()).toBe(false);

    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect(await baselineFunctionExists()).toBe(true);
  });

  it('baseline trigger function rejects mutations with a clear error', async () => {
    // A regular table (not TEMP): pooled queries may run on different connections.
    const conn = orm.em.fork().getConnection();
    await conn.execute('DROP TABLE IF EXISTS append_only_probe');
    await conn.execute('CREATE TABLE append_only_probe (id int)');
    try {
      await conn.execute(
        'CREATE TRIGGER probe_guard BEFORE UPDATE OR DELETE ON append_only_probe FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
      );
      await conn.execute('INSERT INTO append_only_probe VALUES (1)');
      await expect(conn.execute('UPDATE append_only_probe SET id = 2')).rejects.toThrow(
        'table append_only_probe is append-only: UPDATE is not allowed',
      );
      await expect(conn.execute('DELETE FROM append_only_probe')).rejects.toThrow(
        'table append_only_probe is append-only: DELETE is not allowed',
      );
    } finally {
      await conn.execute('DROP TABLE append_only_probe');
    }
  });
});

describe('stack: NestJS application', () => {
  // MikroORM 7 opens the pool lazily, on the first query: the app boots even if Postgres is
  // still starting, and readiness (stage 7) is what reports whether the database is reachable.
  it('boots AppModule on Bun with MikroORM injected and querying the test database', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    try {
      const orm = moduleRef.get(MikroORM);
      const [row] = await orm.em
        .fork()
        .getConnection()
        .execute<{ db: string }[]>('SELECT current_database() AS db');
      expect(row?.db).toBe('wagering_test');
      expect(await orm.isConnected()).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('stack: SQS queues', () => {
  let sqs: SQSClient;

  beforeAll(() => {
    sqs = createSqsClient(config);
  });

  afterAll(() => {
    sqs.destroy();
  });

  const attributesOf = async (queueName: string) => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
    );
    return Attributes ?? {};
  };

  it('provisions the three FIFO queues', async () => {
    for (const name of [config.sqs.wagerQueue, config.sqs.wagerDlq, config.sqs.eventsQueue]) {
      expect((await attributesOf(name)).FifoQueue).toBe('true');
    }
  });

  it('routes the wager queue to the DLQ after maxReceiveCount attempts', async () => {
    const dlqArn = (await attributesOf(config.sqs.wagerDlq)).QueueArn;
    const redrive = JSON.parse((await attributesOf(config.sqs.wagerQueue)).RedrivePolicy ?? '{}');
    expect(redrive.deadLetterTargetArn).toBe(dlqArn);
    expect(Number(redrive.maxReceiveCount)).toBeGreaterThan(0);
  });
});
