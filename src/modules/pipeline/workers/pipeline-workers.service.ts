import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { PipelineService } from "../pipeline.service";

const CONSUMER = "indexer.pipeline";

/**
 * Registers every queue this module owns and subscribes its consumer side
 * (JOB_ORCHESTRATOR_SERVICE_PLAN.md "Jobs: Consumed"). Runs in both the
 * HTTP and `--role=worker` processes, same as SystemService — see
 * main.ts's comment on why job subscriptions aren't role-gated.
 */
@Injectable()
export class PipelineWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly pipeline: PipelineService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const consumedJobs = [
      "repo.import.requested",
      "repo.snapshot.created",
      "repo.files.indexed",
      "repo.symbols.extracted",
      "repo.dependencies.extracted",
      "repo.graph.built",
      "repo.embeddings.completed",
      "repo.stage.failed",
    ] as const;

    // Also published from here — repo.index.requested (to `ai`) and the
    // terminal repo.processing.completed / repo.processing.failed.
    const publishedJobs = ["repo.index.requested", "repo.processing.completed", "repo.processing.failed"] as const;

    for (const jobName of [...consumedJobs, ...publishedJobs]) {
      await ensureProductQueue(this.boss, jobName, DEFAULT_RETRY_POLICY);
    }

    await subscribeJob(
      this.boss,
      "repo.import.requested",
      { consumer: `${CONSUMER}.import_requested`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleImportRequested(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.snapshot.created",
      { consumer: `${CONSUMER}.snapshot_created`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleSnapshotCreated(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.files.indexed",
      { consumer: `${CONSUMER}.files_indexed`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleFilesIndexed(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.symbols.extracted",
      { consumer: `${CONSUMER}.symbols_extracted`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleSymbolsExtracted(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.dependencies.extracted",
      { consumer: `${CONSUMER}.dependencies_extracted`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleDependenciesExtracted(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.graph.built",
      { consumer: `${CONSUMER}.graph_built`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleGraphBuilt(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.embeddings.completed",
      { consumer: `${CONSUMER}.embeddings_completed`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleEmbeddingsCompleted(envelope)
    );

    await subscribeJob(
      this.boss,
      "repo.stage.failed",
      { consumer: `${CONSUMER}.stage_failed`, pool: this.pool, logger: this.logger },
      (envelope) => this.pipeline.handleStageFailed(envelope)
    );
  }
}
