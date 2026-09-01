import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { publishJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS } from "../../shared/infra.module";
import { SnapshotsRepository } from "./snapshots.repository";

const SCHEDULER_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Periodically publishes `snapshot.prune` for every repository that has more
 * than `SNAPSHOT_RETENTION_COUNT` snapshots (SCOPE_LIMITS.md "Snapshot
 * retention", DEVELOPMENT_STAGES.md Stage 10 "`snapshot.prune` scheduled job
 * honouring retention"). Mirrors `StalledJobSweeperService`'s
 * `setInterval` + `unref` shape. `correlationId`/`userId` are synthetic —
 * this is system-initiated, not triggered by a request.
 */
@Injectable()
export class SnapshotPruneSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly snapshots: SnapshotsRepository
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error({ err }, "snapshot-prune sweep failed"));
    }, this.config.SNAPSHOT_PRUNE_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    const retainCount = this.config.SNAPSHOT_RETENTION_COUNT;
    const repoIds = await this.snapshots.listRepoIdsExceedingRetention(retainCount, this.config.SNAPSHOT_PRUNE_BATCH_SIZE);

    for (const repoId of repoIds) {
      await publishJob(this.boss, {
        eventType: "snapshot.prune",
        payload: { repoId, retainCount },
        correlationId: randomUUID(),
        userId: SCHEDULER_USER_ID,
        repoId,
      });
    }

    if (repoIds.length > 0) {
      this.logger.info({ repoCount: repoIds.length, retainCount }, "snapshot prune jobs published");
    }
  }
}
