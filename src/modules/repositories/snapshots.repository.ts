import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

/**
 * `pending`/`downloading` exist for observability while a download is in
 * flight; `superseded` and its retention pruning are Stage 10 scope and no
 * code path sets it yet (GITHUB_CONNECTOR_SERVICE_PLAN.md "Snapshot
 * Lifecycle").
 */
export type SnapshotStatus = "pending" | "downloading" | "stored" | "active" | "superseded" | "failed";

export interface SnapshotRow {
  id: string;
  repo_id: string;
  commit_sha: string;
  ref: string;
  archive_key: string | null;
  manifest_key: string | null;
  // bigint comes back from `pg` as a string to avoid precision loss.
  size_bytes: string | null;
  file_count: number | null;
  status: SnapshotStatus;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePendingSnapshotInput {
  id: string;
  repoId: string;
  commitSha: string;
  ref: string;
}

export interface MarkStoredInput {
  archiveKey: string;
  sizeBytes: number;
}

/** Data access for `repository_snapshots` (GITHUB_CONNECTOR_SERVICE_PLAN.md "Repositories and Snapshots Module"). */
@Injectable()
export class SnapshotsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `UNIQUE (repo_id, commit_sha)` — the row for a given commit is canonical; this is the dedup lookup. */
  async findByRepoAndSha(repoId: string, commitSha: string): Promise<SnapshotRow | null> {
    const rows = await query<SnapshotRow>(
      this.pool,
      "SELECT * FROM repository_snapshots WHERE repo_id = $1 AND commit_sha = $2",
      [repoId, commitSha]
    );
    return rows[0] ?? null;
  }

  async createPending(input: CreatePendingSnapshotInput): Promise<SnapshotRow> {
    const rows = await query<SnapshotRow>(
      this.pool,
      `INSERT INTO repository_snapshots (id, repo_id, commit_sha, ref, status, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', now())
       RETURNING *`,
      [input.id, input.repoId, input.commitSha, input.ref]
    );
    return rows[0]!;
  }

  async markDownloading(id: string): Promise<void> {
    await query(this.pool, "UPDATE repository_snapshots SET status = 'downloading', updated_at = now() WHERE id = $1", [id]);
  }

  async markStored(id: string, input: MarkStoredInput): Promise<SnapshotRow> {
    const rows = await query<SnapshotRow>(
      this.pool,
      `UPDATE repository_snapshots
       SET status = 'stored', archive_key = $2, size_bytes = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.archiveKey, input.sizeBytes]
    );
    return rows[0]!;
  }

  /** Set once the Parser module writes `manifest.json` and the file count is known (`repo.files.indexed`). */
  async markManifest(id: string, input: { manifestKey: string; fileCount: number }): Promise<void> {
    await query(
      this.pool,
      "UPDATE repository_snapshots SET manifest_key = $2, file_count = $3, updated_at = now() WHERE id = $1",
      [id, input.manifestKey, input.fileCount]
    );
  }

  async markFailed(id: string, errorCode: string): Promise<void> {
    await query(
      this.pool,
      "UPDATE repository_snapshots SET status = 'failed', error_code = $2, updated_at = now() WHERE id = $1",
      [id, errorCode]
    );
  }

  /** Newest first — `snapshot.prune` keeps the front of this list. */
  async listByRepoOrderedDesc(repoId: string): Promise<SnapshotRow[]> {
    return query<SnapshotRow>(this.pool, "SELECT * FROM repository_snapshots WHERE repo_id = $1 ORDER BY created_at DESC", [
      repoId,
    ]);
  }

  /** Repos whose snapshot count exceeds `retainCount` — what `SnapshotPruneSchedulerService` sweeps for (SCOPE_LIMITS.md `SNAPSHOT_RETENTION_COUNT`). */
  async listRepoIdsExceedingRetention(retainCount: number, limit: number): Promise<string[]> {
    const rows = await query<{ repo_id: string }>(
      this.pool,
      `SELECT s.repo_id
       FROM repository_snapshots s
       JOIN repositories r ON r.id = s.repo_id AND r.deleted_at IS NULL
       GROUP BY s.repo_id
       HAVING count(*) > $1
       LIMIT $2`,
      [retainCount, limit]
    );
    return rows.map((row) => row.repo_id);
  }

  /** Cascades to `repository_files`, `code_symbols`, `file_dependencies`, `graph_nodes`, `graph_edges`, `graph_build_state`. Idempotent. */
  async deleteById(id: string): Promise<void> {
    await query(this.pool, "DELETE FROM repository_snapshots WHERE id = $1", [id]);
  }
}
