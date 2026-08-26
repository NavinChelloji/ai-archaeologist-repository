import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";
import type { ImportKind } from "./ast-extractor";
import type { ResolutionStatus } from "./import-resolver";

export interface InsertFileDependencyInput {
  id: string;
  repoId: string;
  snapshotId: string;
  sourceFileId: string;
  targetFileId: string | null;
  targetPath: string | null;
  externalPackage: string | null;
  rawSpecifier: string;
  importKind: ImportKind;
  resolutionStatus: ResolutionStatus;
  line: number | null;
}

export interface FileDependencyRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  source_file_id: string;
  target_file_id: string | null;
  target_path: string | null;
  external_package: string | null;
  raw_specifier: string;
  import_kind: ImportKind;
  resolution_status: ResolutionStatus;
  line: number | null;
  created_at: Date;
}

/** Data access for `file_dependencies` (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parser module"). */
@Injectable()
export class FileDependenciesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** See CodeSymbolsRepository.deleteBySnapshot — same delete-then-reinsert idempotency strategy, no natural per-row unique key. */
  async deleteBySnapshot(snapshotId: string): Promise<void> {
    await query(this.pool, "DELETE FROM file_dependencies WHERE snapshot_id = $1", [snapshotId]);
  }

  async insertBatch(rows: InsertFileDependencyInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 11;
      values.push(
        row.id,
        row.repoId,
        row.snapshotId,
        row.sourceFileId,
        row.targetFileId,
        row.targetPath,
        row.externalPackage,
        row.rawSpecifier,
        row.importKind,
        row.resolutionStatus,
        row.line
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    await query(
      this.pool,
      `INSERT INTO file_dependencies (
         id, repo_id, snapshot_id, source_file_id, target_file_id, target_path, external_package, raw_specifier, import_kind, resolution_status, line
       ) VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  async listBySnapshot(snapshotId: string): Promise<FileDependencyRow[]> {
    return query<FileDependencyRow>(this.pool, "SELECT * FROM file_dependencies WHERE snapshot_id = $1", [snapshotId]);
  }
}
