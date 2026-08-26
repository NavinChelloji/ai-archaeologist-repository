import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { GraphNodeType, GraphType } from "@aca/contracts";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface InsertGraphNodeInput {
  id: string;
  repoId: string;
  snapshotId: string;
  graphType: GraphType;
  nodeType: GraphNodeType;
  label: string;
  path: string | null;
  refId: string | null;
  degree: number;
  metadata: Record<string, unknown>;
}

export interface GraphNodeRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  graph_type: GraphType;
  node_type: GraphNodeType;
  label: string;
  path: string | null;
  ref_id: string | null;
  degree: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Data access for `graph_nodes` (GRAPH_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class GraphNodesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Delete-then-reinsert per snapshot, same idempotency strategy as
   * `code_symbols`/`file_dependencies` (Stage 6) — `graph_nodes`'s unique
   * constraint includes a nullable `path` column (external-package nodes
   * have none), and standard SQL treats every `NULL` as distinct from every
   * other `NULL` for uniqueness purposes, so `ON CONFLICT` upsert would
   * silently let duplicate external-package nodes through. Deleting first
   * sidesteps that instead of fighting it with a partial index. Cascades to
   * `graph_edges` via its `ON DELETE CASCADE` foreign keys.
   */
  async deleteBySnapshot(snapshotId: string): Promise<void> {
    await query(this.pool, "DELETE FROM graph_nodes WHERE snapshot_id = $1", [snapshotId]);
  }

  async insertBatch(rows: InsertGraphNodeInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 10;
      values.push(
        row.id,
        row.repoId,
        row.snapshotId,
        row.graphType,
        row.nodeType,
        row.label,
        row.path,
        row.refId,
        row.degree,
        JSON.stringify(row.metadata)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::jsonb)`;
    });

    await query(
      this.pool,
      `INSERT INTO graph_nodes (
         id, repo_id, snapshot_id, graph_type, node_type, label, path, ref_id, degree, metadata
       ) VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  async findById(nodeId: string): Promise<GraphNodeRow | null> {
    const rows = await query<GraphNodeRow>(this.pool, "SELECT * FROM graph_nodes WHERE id = $1", [nodeId]);
    return rows[0] ?? null;
  }

  private filterConditions(input: { snapshotId: string; graphType: GraphType; nodeTypes?: GraphNodeType[]; pathPrefix?: string; path?: string }): {
    conditions: string[];
    values: unknown[];
  } {
    const conditions = ["snapshot_id = $1", "graph_type = $2"];
    const values: unknown[] = [input.snapshotId, input.graphType];

    if (input.nodeTypes && input.nodeTypes.length > 0) {
      values.push(input.nodeTypes);
      conditions.push(`node_type = ANY($${values.length})`);
    }
    if (input.path !== undefined) {
      values.push(input.path);
      conditions.push(`path = $${values.length}`);
    } else if (input.pathPrefix) {
      const escaped = input.pathPrefix.replace(/[\\%_]/g, "\\$&");
      values.push(`${escaped}%`);
      conditions.push(`path LIKE $${values.length} ESCAPE '\\'`);
    }
    return { conditions, values };
  }

  async countFiltered(input: { snapshotId: string; graphType: GraphType; nodeTypes?: GraphNodeType[]; pathPrefix?: string; path?: string }): Promise<number> {
    const { conditions, values } = this.filterConditions(input);
    const rows = await query<{ count: string }>(
      this.pool,
      `SELECT count(*)::text AS count FROM graph_nodes WHERE ${conditions.join(" AND ")}`,
      values
    );
    return Number(rows[0]?.count ?? "0");
  }

  /** Highest-degree nodes first — the truncation selection strategy (GRAPH_SERVICE_PLAN.md "Node Caps and Truncation"). */
  async listByGraphType(input: {
    snapshotId: string;
    graphType: GraphType;
    nodeTypes?: GraphNodeType[];
    pathPrefix?: string;
    path?: string;
    limit: number;
  }): Promise<GraphNodeRow[]> {
    const { conditions, values } = this.filterConditions(input);
    values.push(input.limit);

    return query<GraphNodeRow>(
      this.pool,
      `SELECT * FROM graph_nodes WHERE ${conditions.join(" AND ")} ORDER BY degree DESC, id ASC LIMIT $${values.length}`,
      values
    );
  }

  async findByIds(nodeIds: string[]): Promise<GraphNodeRow[]> {
    if (nodeIds.length === 0) return [];
    return query<GraphNodeRow>(this.pool, "SELECT * FROM graph_nodes WHERE id = ANY($1)", [nodeIds]);
  }

  async findByPath(snapshotId: string, graphType: GraphType, path: string): Promise<GraphNodeRow | null> {
    const rows = await query<GraphNodeRow>(
      this.pool,
      "SELECT * FROM graph_nodes WHERE snapshot_id = $1 AND graph_type = $2 AND path = $3 LIMIT 1",
      [snapshotId, graphType, path]
    );
    return rows[0] ?? null;
  }

  /** Case-insensitive prefix search over the indexed `lower(label)` column, optionally scoped to specific graph types. */
  async search(input: { snapshotId: string; q: string; graphTypes?: GraphType[]; limit: number }): Promise<GraphNodeRow[]> {
    const escaped = input.q.toLowerCase().replace(/[\\%_]/g, "\\$&");
    const conditions = ["snapshot_id = $1", `lower(label) LIKE $2 ESCAPE '\\'`];
    const values: unknown[] = [input.snapshotId, `%${escaped}%`];

    if (input.graphTypes && input.graphTypes.length > 0) {
      values.push(input.graphTypes);
      conditions.push(`graph_type = ANY($${values.length})`);
    }
    values.push(input.limit);

    return query<GraphNodeRow>(
      this.pool,
      `SELECT * FROM graph_nodes WHERE ${conditions.join(" AND ")} ORDER BY degree DESC, id ASC LIMIT $${values.length}`,
      values
    );
  }
}
