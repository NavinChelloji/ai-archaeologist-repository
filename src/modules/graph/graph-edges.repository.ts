import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { GraphEdgeType, GraphType } from "@aca/contracts";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface InsertGraphEdgeInput {
  id: string;
  repoId: string;
  snapshotId: string;
  graphType: GraphType;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: GraphEdgeType;
}

export interface GraphEdgeRow {
  id: string;
  repo_id: string;
  snapshot_id: string;
  graph_type: GraphType;
  source_node_id: string;
  target_node_id: string;
  edge_type: GraphEdgeType;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export type NeighborDirection = "in" | "out" | "both";

/** Data access for `graph_edges` (GRAPH_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class GraphEdgesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Explicit alongside `GraphNodesRepository.deleteBySnapshot` (which already cascades here) — see that method's doc comment. */
  async deleteBySnapshot(snapshotId: string): Promise<void> {
    await query(this.pool, "DELETE FROM graph_edges WHERE snapshot_id = $1", [snapshotId]);
  }

  async insertBatch(rows: InsertGraphEdgeInput[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 7;
      values.push(row.id, row.repoId, row.snapshotId, row.graphType, row.sourceNodeId, row.targetNodeId, row.edgeType);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });

    await query(
      this.pool,
      `INSERT INTO graph_edges (
         id, repo_id, snapshot_id, graph_type, source_node_id, target_node_id, edge_type
       ) VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  /** Every edge with both endpoints inside `nodeIds` — used once truncation has already picked the node subset, so the canvas only ever gets edges between visible nodes. */
  async listAmongNodes(snapshotId: string, nodeIds: string[]): Promise<GraphEdgeRow[]> {
    if (nodeIds.length === 0) return [];
    return query<GraphEdgeRow>(
      this.pool,
      "SELECT * FROM graph_edges WHERE snapshot_id = $1 AND source_node_id = ANY($2) AND target_node_id = ANY($2)",
      [snapshotId, nodeIds]
    );
  }

  /**
   * One hop of neighbour expansion from a frontier of node ids
   * (GRAPH_SERVICE_PLAN.md "`direction` is `in` | `out` | `both`. `in`
   * answers 'who imports this file?', served by the reverse index on
   * `graph_edges(target_node_id, edge_type)`"). Called once per BFS depth
   * level by the read service — `GRAPH_NEIGHBOR_MAX_DEPTH` keeps that
   * shallow enough that iterative round-trips beat a recursive CTE's added
   * complexity for this scope.
   */
  async listByNodeIds(input: { snapshotId: string; nodeIds: string[]; direction: NeighborDirection }): Promise<GraphEdgeRow[]> {
    if (input.nodeIds.length === 0) return [];
    if (input.direction === "out") {
      return query<GraphEdgeRow>(this.pool, "SELECT * FROM graph_edges WHERE snapshot_id = $1 AND source_node_id = ANY($2)", [
        input.snapshotId,
        input.nodeIds,
      ]);
    }
    if (input.direction === "in") {
      return query<GraphEdgeRow>(this.pool, "SELECT * FROM graph_edges WHERE snapshot_id = $1 AND target_node_id = ANY($2)", [
        input.snapshotId,
        input.nodeIds,
      ]);
    }
    return query<GraphEdgeRow>(
      this.pool,
      "SELECT * FROM graph_edges WHERE snapshot_id = $1 AND (source_node_id = ANY($2) OR target_node_id = ANY($2))",
      [input.snapshotId, input.nodeIds]
    );
  }
}
