import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Logger } from "@aca/logger";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER } from "../../shared/infra.module";
import { ProcessingJobsRepository } from "./processing-jobs.repository";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deletes terminal `processing_jobs` (and, via cascade, their
 * `job_stage_events`) older than `JOB_EVENT_RETENTION_DAYS`
 * (DATA_RETENTION_AND_PRIVACY.md "Retention": "Job records and stage events
 * | JOB_EVENT_RETENTION_DAYS (30) | Scheduled cleanup"). Mirrors
 * `StalledJobSweeperService`'s `setInterval` + `unref` shape.
 */
@Injectable()
export class JobRetentionSweeperService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly jobs: ProcessingJobsRepository
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error({ err }, "job-retention sweep failed"));
    }, this.config.JOB_RETENTION_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.JOB_EVENT_RETENTION_DAYS * MS_PER_DAY);
    const deletedCount = await this.jobs.deleteTerminalOlderThan(cutoff);
    if (deletedCount > 0) {
      this.logger.info({ deletedCount, cutoff }, "job retention sweep completed");
    }
  }
}
