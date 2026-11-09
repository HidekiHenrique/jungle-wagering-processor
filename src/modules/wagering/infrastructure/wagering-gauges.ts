import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrometheusMetrics } from '../../../shared/infrastructure/metrics/prometheus-metrics';

/** Scrape-time gauge: how many operations are parked waiting for their reference. */
@Injectable()
export class WageringGauges implements OnModuleInit {
  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    this.metrics.registerGauge(
      'wager_pending_reference_transactions',
      'Transactions in PENDING_REFERENCE (waiting for the referenced operation)',
      async () => {
        const [row] = await this.em
          .fork()
          .execute<{ n: string }[]>(
            `SELECT count(*) AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
          );
        return Number(row?.n ?? 0);
      },
    );
  }
}
