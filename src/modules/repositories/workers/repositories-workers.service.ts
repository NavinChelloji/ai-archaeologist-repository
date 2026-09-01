import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { DeletionService } from "../deletion.service";
import { SnapshotDownloadService } from "../snapshot-download.service";
import { SnapshotPruneService } from "../snapshot-prune.service";

const CONSUMER = "indexer.repositories";

/** This module's own fan-out queue for `repo.import.requested` — see `FANOUT_QUEUES` in `@aca/queue`. Pipeline consumes the same event on its own, separately-named queue for job bookkeeping. */
const IMPORT_QUEUE_NAME = "repo.import.requested.snapshots";

/**
 * Registers this module's queue subscriptions (GITHUB_CONNECTOR_SERVICE_PLAN.md
 * "Jobs: Consumed"; DATA_RETENTION_AND_PRIVACY.md "Deletion" and
 * "Retention"). Runs in both the HTTP and `--role=worker` processes, same as
 * PipelineWorkersService. `repo.deleted`, `user.deleted`, and
 * `snapshot.prune` use their default (job-named) queues here — `ai` consumes
 * the same three events on its own `.ai`-suffixed fan-out queues.
 */
@Injectable()
export class RepositoriesWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly snapshots: SnapshotDownloadService,
    private readonly deletion: DeletionService,
    private readonly prune: SnapshotPruneService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.import.requested", DEFAULT_RETRY_POLICY, IMPORT_QUEUE_NAME);
    await ensureProductQueue(this.boss, "repo.deleted", DEFAULT_RETRY_POLICY);
    await ensureProductQueue(this.boss, "user.deleted", DEFAULT_RETRY_POLICY);
    await ensureProductQueue(this.boss, "snapshot.prune", DEFAULT_RETRY_POLICY);

    await subscribeJob(
      this.boss,
      "repo.import.requested",
      { consumer: `${CONSUMER}.import_requested`, pool: this.pool, logger: this.logger },
      (envelope) => this.snapshots.handleImportRequested(envelope),
      IMPORT_QUEUE_NAME
    );

    await subscribeJob(
      this.boss,
      "repo.deleted",
      { consumer: `${CONSUMER}.repo_deleted`, pool: this.pool, logger: this.logger },
      (envelope) => this.deletion.deleteRepository(envelope.payload.repoId)
    );

    await subscribeJob(
      this.boss,
      "user.deleted",
      { consumer: `${CONSUMER}.user_deleted`, pool: this.pool, logger: this.logger },
      (envelope) => this.deletion.deleteForUser(envelope.payload.userId, envelope.payload.repoIds)
    );

    await subscribeJob(
      this.boss,
      "snapshot.prune",
      { consumer: `${CONSUMER}.snapshot_prune`, pool: this.pool, logger: this.logger },
      (envelope) => this.prune.handleSnapshotPrune(envelope)
    );
  }
}
