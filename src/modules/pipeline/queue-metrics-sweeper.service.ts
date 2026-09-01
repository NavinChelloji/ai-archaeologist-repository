import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { listAllQueueNames } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { QUEUE_METRICS } from "../../shared/metrics/metrics.module";
import type { QueueMetrics } from "@aca/metrics";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS } from "../../shared/infra.module";
import { ProcessingJobsRepository } from "./processing-jobs.repository";

const MS_PER_SECOND = 1000;

/**
 * Periodically refreshes the queue depth, DLQ depth, and oldest-job-age
 * gauges (RULES.md #15, #22 "Alerts for ... DLQ arrivals, stalled jobs").
 * Mirrors `StalledJobSweeperService`'s `setInterval` + `unref` shape. Lives
 * in the Pipeline module since `processing_jobs` (the job-age source) is
 * this module's own table.
 */
@Injectable()
export class QueueMetricsSweeperService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(QUEUE_METRICS) private readonly metrics: QueueMetrics,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly jobs: ProcessingJobsRepository
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error({ err }, "queue metrics sweep failed"));
    }, this.config.QUEUE_METRICS_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    await Promise.all(listAllQueueNames().map((queue) => this.refreshQueue(queue)));
    await this.refreshOldestJobAge();
  }

  private async refreshQueue(queue: string): Promise<void> {
    const [depth, dlqDepth] = await Promise.all([this.boss.getQueueSize(queue), this.boss.getQueueSize(`${queue}.dlq`)]);
    this.metrics.queueDepth.set({ queue }, depth ?? 0);
    this.metrics.dlqDepth.set({ queue }, dlqDepth ?? 0);
  }

  private async refreshOldestJobAge(): Promise<void> {
    const oldest = await this.jobs.findOldestActive();
    const ageSeconds = oldest ? (Date.now() - oldest.created_at.getTime()) / MS_PER_SECOND : 0;
    this.metrics.oldestJobAgeSeconds.set({ status: "active" }, ageSeconds);
  }
}
