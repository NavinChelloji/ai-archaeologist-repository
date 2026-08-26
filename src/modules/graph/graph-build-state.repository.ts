import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export type ReadyInput = "files" | "symbols" | "dependencies";

const READY_COLUMNS: Record<ReadyInput, string> = {
  files: "files_ready",
  symbols: "symbols_ready",
  dependencies: "dependencies_ready",
};

export interface GraphBuildStateRow {
  snapshot_id: string;
  repo_id: string;
  files_ready: boolean;
  symbols_ready: boolean;
  dependencies_ready: boolean;
  built_at: Date | null;
  updated_at: Date;
}

/**
 * Arrival tracking for the three Parser terminal events a graph build needs
 * (GRAPH_SERVICE_PLAN.md "Build trigger — stated explicitly"). `which` is
 * drawn from a closed, code-defined 3-value union — `READY_COLUMNS` maps it
 * to a column name so the interpolation below can never carry attacker- or
 * request-controlled text (RULES.md #10 "always parameterized" — column
 * names can't be bind parameters in Postgres, so a whitelisted lookup is the
 * parameterized-equivalent for the identifier itself).
 */
@Injectable()
export class GraphBuildStateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async markReady(repoId: string, snapshotId: string, which: ReadyInput): Promise<GraphBuildStateRow> {
    const column = READY_COLUMNS[which];
    const rows = await query<GraphBuildStateRow>(
      this.pool,
      `INSERT INTO graph_build_state (snapshot_id, repo_id, ${column})
       VALUES ($1, $2, true)
       ON CONFLICT (snapshot_id) DO UPDATE SET ${column} = true, updated_at = now()
       RETURNING *`,
      [snapshotId, repoId]
    );
    return rows[0]!;
  }

  /**
   * Atomically claims the right to build this snapshot's graphs: succeeds
   * (returns true) exactly once, for whichever of the three terminal
   * handlers happens to observe all three flags ready first — concurrent
   * callers race on the same row and Postgres's row lock serializes them, so
   * only one `UPDATE` can match `built_at IS NULL` (GRAPH_SERVICE_PLAN.md
   * "Build fires exactly once ... regardless of arrival order").
   */
  async tryClaimBuild(snapshotId: string): Promise<boolean> {
    const rows = await query<{ snapshot_id: string }>(
      this.pool,
      `UPDATE graph_build_state
       SET built_at = now(), updated_at = now()
       WHERE snapshot_id = $1 AND files_ready AND symbols_ready AND dependencies_ready AND built_at IS NULL
       RETURNING snapshot_id`,
      [snapshotId]
    );
    return rows.length > 0;
  }

  /** Releases the claim on build failure so a retried snapshot can rebuild rather than being permanently skipped. */
  async releaseClaim(snapshotId: string): Promise<void> {
    await query(this.pool, "UPDATE graph_build_state SET built_at = NULL, updated_at = now() WHERE snapshot_id = $1", [snapshotId]);
  }
}
