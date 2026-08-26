import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { SnapshotDownloadService } from "../snapshot-download.service";

const CONSUMER = "indexer.snapshots";

/** This module's own fan-out queue for `repo.import.requested` — see `FANOUT_QUEUES` in `@aca/queue`. Pipeline consumes the same event on its own, separately-named queue for job bookkeeping. */
const QUEUE_NAME = "repo.import.requested.snapshots";

/**
 * Registers this module's queue subscription (GITHUB_CONNECTOR_SERVICE_PLAN.md
 * "Jobs: Consumed"). Runs in both the HTTP and `--role=worker` processes,
 * same as PipelineWorkersService.
 */
@Injectable()
export class RepositoriesWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly snapshots: SnapshotDownloadService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.import.requested", DEFAULT_RETRY_POLICY, QUEUE_NAME);

    await subscribeJob(
      this.boss,
      "repo.import.requested",
      { consumer: `${CONSUMER}.import_requested`, pool: this.pool, logger: this.logger },
      (envelope) => this.snapshots.handleImportRequested(envelope),
      QUEUE_NAME
    );
  }
}
