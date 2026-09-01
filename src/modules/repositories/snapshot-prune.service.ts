import { Inject, Injectable } from "@nestjs/common";
import type { TypedEnvelope } from "@aca/contracts";
import type { Logger } from "@aca/logger";
import { deleteObjectsByPrefix, snapshotPrefix, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, S3_CLIENT } from "../../shared/infra.module";
import { RepositoriesRepository } from "./repositories.repository";
import { SnapshotsRepository } from "./snapshots.repository";

/**
 * Handles `snapshot.prune` (DATA_RETENTION_AND_PRIVACY.md "Retention":
 * "Superseded snapshot archives and file text ... `snapshot.prune` job + S3
 * lifecycle"). Retains the active snapshot plus the `retainCount` most
 * recent by `created_at`; everything else is deleted, cascading to every
 * child table and its S3 objects. Idempotent — a snapshot already pruned by
 * an earlier delivery simply isn't in the list the second time.
 */
@Injectable()
export class SnapshotPruneService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly repositories: RepositoriesRepository,
    private readonly snapshots: SnapshotsRepository
  ) {}

  async handleSnapshotPrune(envelope: TypedEnvelope<"snapshot.prune">): Promise<void> {
    const { repoId, retainCount } = envelope.payload;
    const repository = await this.repositories.findById(repoId);
    const all = await this.snapshots.listByRepoOrderedDesc(repoId);

    const retainIds = new Set(all.slice(0, retainCount).map((s) => s.id));
    if (repository?.active_snapshot_id) retainIds.add(repository.active_snapshot_id);

    const toPrune = all.filter((s) => !retainIds.has(s.id));
    for (const snapshot of toPrune) {
      await this.snapshots.deleteById(snapshot.id);
      await deleteObjectsByPrefix(this.s3, this.config.S3_BUCKET, snapshotPrefix(repoId, snapshot.id));
    }

    this.logger.info(
      { repoId, retainCount, prunedCount: toPrune.length, retainedCount: retainIds.size },
      "snapshot prune completed"
    );
  }

  /** Backs `GET /internal/repositories/:repoId/snapshots` — the set `ai` treats as valid when cleaning up its own `snapshot_chunks` after a prune. */
  async listRetainedSnapshotIds(repoId: string): Promise<string[]> {
    const rows = await this.snapshots.listByRepoOrderedDesc(repoId);
    return rows.map((row) => row.id);
  }
}
