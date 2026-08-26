import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";
import type { SymbolType } from "./ast-extractor";

export interface InsertCodeSymbolInput {
  id: string;
  repoId: string;
  snapshotId: string;
  fileId: string;
  parentSymbolId: string | null;
  symbolType: SymbolType;
  name: string;
  qualifiedName: string | null;
  signature: string | null;
  isExported: boolean;
  startLine: number;
  endLine: number;
  /** Class/interface heritage (`{ extends: string[]; implements: string[] }`) for the graph module — see ast-extractor.ts's RawHeritage. Empty object for every other symbol type. */
  metadata: Record<string, unknown>;
}

export interface CodeSymbolRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  file_id: string;
  parent_symbol_id: string | null;
  symbol_type: SymbolType;
  name: string;
  qualified_name: string | null;
  signature: string | null;
  is_exported: boolean;
  start_line: number;
  end_line: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface SymbolsCursor {
  name: string;
  id: string;
}

export interface ListSymbolsInput {
  snapshotId: string;
  pageSize: number;
  cursor: SymbolsCursor | null;
  type?: SymbolType;
  namePrefix?: string;
}

/** Data access for `code_symbols` (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parser module"). */
@Injectable()
export class CodeSymbolsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Retried snapshots (`repo.snapshot.created` replay) re-run extraction end
   * to end, so this module deletes and re-inserts per snapshot rather than
   * upserting — `code_symbols` has no natural per-row unique key the way
   * `repository_files` has `(snapshot_id, path)`.
   */
  async deleteBySnapshot(snapshotId: string): Promise<void> {
    await query(this.pool, "DELETE FROM code_symbols WHERE snapshot_id = $1", [snapshotId]);
  }

  /** Rows must be ordered parent-before-child within a batch — Postgres checks the self-referencing FK per row, in VALUES order. */
  async insertBatch(rows: InsertCodeSymbolInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 13;
      values.push(
        row.id,
        row.repoId,
        row.snapshotId,
        row.fileId,
        row.parentSymbolId,
        row.symbolType,
        row.name,
        row.qualifiedName,
        row.signature,
        row.isExported,
        row.startLine,
        row.endLine,
        JSON.stringify(row.metadata)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}::jsonb)`;
    });

    await query(
      this.pool,
      `INSERT INTO code_symbols (
         id, repo_id, snapshot_id, file_id, parent_symbol_id, symbol_type, name, qualified_name, signature, is_exported, start_line, end_line, metadata
       ) VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  /** Every row for a snapshot, unpaginated — for internal bulk consumers like the Graph module's builders, not the paginated HTTP API. */
  async listAllBySnapshot(snapshotId: string): Promise<CodeSymbolRow[]> {
    return query<CodeSymbolRow>(this.pool, "SELECT * FROM code_symbols WHERE snapshot_id = $1", [snapshotId]);
  }

  /** Keyset-paginated over `(name, id)` ascending; `namePrefix` search uses the `lower(name)` index. */
  async listBySnapshot(input: ListSymbolsInput): Promise<CodeSymbolRow[]> {
    const conditions = ["snapshot_id = $1"];
    const values: unknown[] = [input.snapshotId];

    if (input.type) {
      values.push(input.type);
      conditions.push(`symbol_type = $${values.length}`);
    }
    if (input.namePrefix) {
      const escaped = input.namePrefix.toLowerCase().replace(/[\\%_]/g, "\\$&");
      values.push(`${escaped}%`);
      conditions.push(`lower(name) LIKE $${values.length} ESCAPE '\\'`);
    }
    if (input.cursor) {
      values.push(input.cursor.name, input.cursor.id);
      conditions.push(`(name, id) > ($${values.length - 1}, $${values.length})`);
    }
    values.push(input.pageSize);

    return query<CodeSymbolRow>(
      this.pool,
      `SELECT * FROM code_symbols WHERE ${conditions.join(" AND ")} ORDER BY name ASC, id ASC LIMIT $${values.length}`,
      values
    );
  }
}
