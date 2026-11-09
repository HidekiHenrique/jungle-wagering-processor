import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { type BeforeApplicationShutdown, Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../shared/infrastructure/config/app-config';
import { PrometheusMetrics } from '../../shared/infrastructure/metrics/prometheus-metrics';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../messaging/infrastructure/sqs/sqs-client.provider';

const CHECK_TIMEOUT_MS = 2_000;

type CheckResult = 'up' | 'down';

/**
 * Operational endpoints, deliberately outside authentication (challenge §2).
 *
 *   /health/live   the process is running (a failing liveness probe restarts the container)
 *   /health/ready  dependencies reachable: may receive traffic (failing readiness only removes the
 *                  instance from the load balancer; it is not restarted)
 *   /metrics       Prometheus exposition
 */
@Controller()
export class HealthController implements BeforeApplicationShutdown {
  private draining = false;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queueUrls: QueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: PrometheusMetrics,
  ) {}

  /** On SIGTERM, report not-ready first so the load balancer stops sending new requests. */
  beforeApplicationShutdown(): void {
    this.draining = true;
  }

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, sqs] = await Promise.all([
      this.check(() => this.em.fork().execute('SELECT 1')),
      this.check(async () =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queueUrls.get(this.config.sqs.wagerQueue),
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    ]);
    const ok = !this.draining && database === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : this.draining ? 'draining' : 'unavailable', checks: { database, sqs } };
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckResult> {
    const timeout = Bun.sleep(CHECK_TIMEOUT_MS).then(() => 'down' as const);
    const result = probe().then(
      () => 'up' as const,
      () => 'down' as const,
    );
    return Promise.race([result, timeout]);
  }
}
