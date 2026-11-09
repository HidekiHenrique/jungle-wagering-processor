import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../shared/infrastructure/config/app-config';
import { ProcessPendingReferencesUseCase } from '../../application/use-cases/process-pending-references.use-case';

/** Scheduled loop around ProcessPendingReferencesUseCase. Runs in every instance (SKIP LOCKED inside). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly processPending: ProcessPendingReferencesUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.pendingReferenceEnabled) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.logger.log({ msg: 'Pending reference worker stopped' });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    const { pendingReferencePollIntervalMs, pendingReferenceBatchSize } = this.config.workers;
    while (this.running) {
      try {
        const result = await this.processPending.execute(pendingReferenceBatchSize);
        if (result.handled > 0 || result.failed > 0)
          this.logger.log({ msg: 'Pending references retried', ...result });
        // A full batch suggests backlog: go again immediately.
        if (result.handled + result.skipped < pendingReferenceBatchSize)
          await Bun.sleep(pendingReferencePollIntervalMs);
      } catch (error) {
        this.logger.error({ msg: 'Pending reference run failed', error: String(error) });
        await Bun.sleep(pendingReferencePollIntervalMs);
      }
    }
  }
}
