import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Logger } from "@aca/logger";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER } from "../../shared/infra.module";
import { ProcessingJobsRepository } from "./processing-jobs.repository";
import { PipelineService } from "./pipeline.service";

/**
 * Fails any job whose `updated_at` predates `STAGE_TIMEOUT_SECONDS`
 * (JOB_ORCHESTRATOR_SERVICE_PLAN.md "Stalled Job Handling"). Without this a
 * worker killed mid-stage leaves a job running forever and the UI spins
 * indefinitely.
 */
@Injectable()
export class StalledJobSweeperService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly jobs: ProcessingJobsRepository,
    private readonly pipeline: PipelineService
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error({ err }, "stalled-job sweep failed"));
    }, this.config.STALLED_JOB_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.STAGE_TIMEOUT_SECONDS * 1000);
    const stalled = await this.jobs.findStalled(cutoff);

    for (const job of stalled) {
      this.logger.warn({ jobId: job.id, repoId: job.repo_id, stage: job.current_stage }, "failing stalled job");
      await this.pipeline.failStalled(job);
    }
  }
}
