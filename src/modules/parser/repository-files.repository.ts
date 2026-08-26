import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface RepositoryFileRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  path: string;
  directory: string;
  extension: string | null;
  language: string | null;
  size_bytes: number;
  line_count: number;
  content_hash: string;
  object_key: string;
  created_at: Date;
}

export interface FilesCursor {
  path: string;
  id: string;
}

export interface ListFilesInput {
  snapshotId: string;
  pageSize: number;
  cursor: FilesCursor | null;
  pathPrefix?: string;
}

export interface InsertRepositoryFileInput {
  id: string;
  repoId: string;
  snapshotId: string;
  path: string;
  directory: string;
  extension: string | null;
  language: string | null;
  sizeBytes: number;
  lineCount: number;
  contentHash: string;
  objectKey: string;
}

/** Data access for `repository_files` (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parser module"). */
@Injectable()
export class RepositoryFilesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * `ON CONFLICT (snapshot_id, path) DO UPDATE` makes this idempotent both
   * within a retried job (same snapshot re-extracted after a crash) and for
   * a snapshot reused across a reindex-at-unchanged-SHA — either way, this
   * is the row that should exist for that path afterward, not a duplicate.
   */
  async insertBatch(rows: InsertRepositoryFileInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 11;
      values.push(
        row.id,
        row.repoId,
        row.snapshotId,
        row.path,
        row.directory,
        row.extension,
        row.language,
        row.sizeBytes,
        row.lineCount,
        row.contentHash,
        row.objectKey
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    await query(
      this.pool,
      `INSERT INTO repository_files (
         id, repo_id, snapshot_id, path, directory, extension, language, size_bytes, line_count, content_hash, object_key
       ) VALUES ${placeholders.join(", ")}
       ON CONFLICT (snapshot_id, path) DO UPDATE SET
         size_bytes = EXCLUDED.size_bytes,
         line_count = EXCLUDED.line_count,
         content_hash = EXCLUDED.content_hash,
         object_key = EXCLUDED.object_key,
         language = EXCLUDED.language,
         extension = EXCLUDED.extension`,
      values
    );
  }

  async countBySnapshot(snapshotId: string): Promise<number> {
    const rows = await query<{ count: string }>(
      this.pool,
      "SELECT count(*)::text AS count FROM repository_files WHERE snapshot_id = $1",
      [snapshotId]
    );
    return Number(rows[0]?.count ?? "0");
  }

  async findById(fileId: string): Promise<RepositoryFileRow | null> {
    const rows = await query<RepositoryFileRow>(this.pool, "SELECT * FROM repository_files WHERE id = $1", [fileId]);
    return rows[0] ?? null;
  }

  /** Every row for a snapshot, unpaginated — for internal bulk consumers like the Graph module's builders, not the paginated HTTP API. */
  async listAllBySnapshot(snapshotId: string): Promise<RepositoryFileRow[]> {
    return query<RepositoryFileRow>(this.pool, "SELECT * FROM repository_files WHERE snapshot_id = $1", [snapshotId]);
  }

  /** Keyset-paginated over `(path, id)` ascending — natural alphabetical file-tree order. */
  async listBySnapshot(input: ListFilesInput): Promise<RepositoryFileRow[]> {
    const conditions = ["snapshot_id = $1"];
    const values: unknown[] = [input.snapshotId];

    if (input.pathPrefix) {
      const escaped = input.pathPrefix.replace(/[\\%_]/g, "\\$&");
      values.push(`${escaped}%`);
      conditions.push(`path LIKE $${values.length} ESCAPE '\\'`);
    }
    if (input.cursor) {
      values.push(input.cursor.path, input.cursor.id);
      conditions.push(`(path, id) > ($${values.length - 1}, $${values.length})`);
    }
    values.push(input.pageSize);

    return query<RepositoryFileRow>(
      this.pool,
      `SELECT * FROM repository_files WHERE ${conditions.join(" AND ")} ORDER BY path ASC, id ASC LIMIT $${values.length}`,
      values
    );
  }
}
