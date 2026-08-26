import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import {
  AppError,
  type GraphDependenciesQuery,
  type GraphEdgeDto,
  type GraphFoldersQuery,
  type GraphNeighborsQuery,
  type GraphNodeDto,
  type GraphNodeType,
  type GraphResponse,
  type GraphSearchQuery,
  type GraphSearchResponse,
  type GraphSymbolsQuery,
  type GraphType,
  type TreeNodeDto,
  type TreeQuery,
  type TreeResponse,
} from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { REDIS_CLIENT } from "../../shared/infra.module";
import { RepositoriesService } from "../repositories/repositories.service";
import { basename } from "./builders/graph-builder-types";
import { GraphEdgesRepository, type GraphEdgeRow, type NeighborDirection } from "./graph-edges.repository";
import { GraphNodesRepository, type GraphNodeRow } from "./graph-nodes.repository";

const CACHE_PREFIX = "graph";

/**
 * The read side of the Graph module (GRAPH_SERVICE_PLAN.md "APIs", "Node
 * Caps and Truncation", "Stateless Design"). Every query is scoped to the
 * repository's active snapshot; Redis caching is keyed by that snapshot id
 * so cutover invalidates it for free — the next request simply resolves a
 * different snapshot id and therefore a different cache key, never a stale
 * one (GRAPH_SERVICE_PLAN.md "Cache keys include snapshotId").
 */
@Injectable()
export class GraphReadService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly repositories: RepositoriesService,
    private readonly nodes: GraphNodesRepository,
    private readonly edges: GraphEdgesRepository
  ) {}

  async getFolders(repoId: string, query: GraphFoldersQuery): Promise<GraphResponse> {
    return this.getGraphByType(repoId, "folder", { pathPrefix: query.rootPath, maxNodes: query.maxNodes });
  }

  async getDependencies(repoId: string, query: GraphDependenciesQuery): Promise<GraphResponse> {
    const nodeTypes: GraphNodeType[] | undefined = query.includeExternal ? undefined : ["file"];
    return this.getGraphByType(repoId, "dependency", { pathPrefix: query.scopePath, nodeTypes, maxNodes: query.maxNodes });
  }

  async getSymbols(repoId: string, query: GraphSymbolsQuery): Promise<GraphResponse> {
    const nodeTypes: GraphNodeType[] | undefined = query.symbolType ? [query.symbolType] : undefined;
    return this.getGraphByType(repoId, "symbol", { path: query.filePath, nodeTypes, maxNodes: query.maxNodes });
  }

  async search(repoId: string, query: GraphSearchQuery): Promise<GraphSearchResponse> {
    const snapshotId = await this.requireActiveSnapshot(repoId);
    const rows = await this.nodes.search({ snapshotId, q: query.q, graphTypes: query.types, limit: 50 });
    return { results: rows.map((row) => ({ graphType: row.graph_type, node: toNodeDto(row) })) };
  }

  async getTree(repoId: string, query: TreeQuery): Promise<TreeResponse> {
    const snapshotId = await this.requireActiveSnapshot(repoId);
    const rootPath = query.path ?? "";
    const rootNode = await this.nodes.findByPath(snapshotId, "folder", rootPath);

    if (!rootNode) {
      if (rootPath !== "") throw new AppError("NODE_NOT_FOUND", "No such path in this repository's active snapshot.");
      // An empty (but successfully indexed) repository has no root directory row at all — a synthetic empty root beats erroring on a legitimate state.
      return { snapshotId, root: { id: randomUUID(), name: "/", path: "", type: "directory", language: null, children: [] } };
    }

    return { snapshotId, root: await this.buildTreeNode(snapshotId, rootNode, query.depth) };
  }

  async getNeighbors(repoId: string, nodeId: string, query: GraphNeighborsQuery): Promise<GraphResponse> {
    const snapshotId = await this.requireActiveSnapshot(repoId);
    const rootNode = await this.nodes.findById(nodeId);
    if (!rootNode || rootNode.snapshot_id !== snapshotId) {
      throw new AppError("NODE_NOT_FOUND", "No such graph node in this repository's active snapshot.");
    }

    const maxDepth = Math.min(query.depth ?? this.config.GRAPH_NEIGHBOR_MAX_DEPTH, this.config.GRAPH_NEIGHBOR_MAX_DEPTH);
    const maxNodes = query.maxNodes ?? this.config.GRAPH_QUERY_MAX_NODES;

    const { visited, hitCap } = await this.expandNeighbors(snapshotId, rootNode, query.direction, maxDepth, maxNodes);
    const selected = [...visited.values()];
    const edgeRows = await this.edges.listAmongNodes(snapshotId, selected.map((n) => n.id));

    // Neighbour expansion never counts the true unbounded total (that would defeat the point of the cap) — when the
    // cap was hit, `totalNodes` is a documented lower bound (what we actually found), not an exact count.
    return this.toGraphResponse(rootNode.graph_type, snapshotId, selected, edgeRows, hitCap ? selected.length + 1 : selected.length);
  }

  private async expandNeighbors(
    snapshotId: string,
    rootNode: GraphNodeRow,
    direction: NeighborDirection,
    maxDepth: number,
    maxNodes: number
  ): Promise<{ visited: Map<string, GraphNodeRow>; hitCap: boolean }> {
    const visited = new Map<string, GraphNodeRow>([[rootNode.id, rootNode]]);
    let frontier = [rootNode.id];
    let hitCap = false;

    for (let depth = 0; depth < maxDepth && visited.size < maxNodes && frontier.length > 0; depth += 1) {
      const hopEdges = await this.edges.listByNodeIds({ snapshotId, nodeIds: frontier, direction });
      const nextIds = new Set<string>();
      for (const edge of hopEdges) {
        const otherId = direction === "out" ? edge.target_node_id : direction === "in" ? edge.source_node_id : otherEndpoint(edge, frontier);
        if (!visited.has(otherId)) nextIds.add(otherId);
      }
      if (nextIds.size === 0) break;

      const nextNodes = await this.nodes.findByIds([...nextIds]);
      const admitted: string[] = [];
      for (const node of nextNodes) {
        if (visited.size >= maxNodes) {
          hitCap = true;
          break;
        }
        visited.set(node.id, node);
        admitted.push(node.id);
      }
      if (nextNodes.length > admitted.length) hitCap = true;
      frontier = admitted;
    }

    return { visited, hitCap };
  }

  private async buildTreeNode(snapshotId: string, node: GraphNodeRow, remainingDepth: number): Promise<TreeNodeDto> {
    const base: TreeNodeDto = {
      id: node.id,
      name: node.path === "" ? "/" : basename(node.path ?? ""),
      path: node.path ?? "",
      type: node.node_type === "directory" ? "directory" : "file",
      language: typeof node.metadata.language === "string" ? node.metadata.language : null,
    };
    if (node.node_type !== "directory") return base;

    const childEdges = await this.edges.listByNodeIds({ snapshotId, nodeIds: [node.id], direction: "out" });
    if (childEdges.length === 0) return { ...base, children: [] };
    if (remainingDepth <= 0) return { ...base, hasChildren: true };

    const childNodes = await this.nodes.findByIds(childEdges.map((e) => e.target_node_id));
    const children = await Promise.all(childNodes.map((child) => this.buildTreeNode(snapshotId, child, remainingDepth - 1)));
    children.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
    return { ...base, children };
  }

  private async getGraphByType(
    repoId: string,
    graphType: GraphType,
    opts: { nodeTypes?: GraphNodeType[]; pathPrefix?: string; path?: string; maxNodes?: number }
  ): Promise<GraphResponse> {
    const snapshotId = await this.requireActiveSnapshot(repoId);
    const key = cacheKey(snapshotId, graphType, opts);

    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as GraphResponse;

    const maxNodes = opts.maxNodes ?? this.config.GRAPH_QUERY_MAX_NODES;
    const filter = { snapshotId, graphType, nodeTypes: opts.nodeTypes, pathPrefix: opts.pathPrefix, path: opts.path };
    const [totalNodes, selected] = await Promise.all([
      this.nodes.countFiltered(filter),
      this.nodes.listByGraphType({ ...filter, limit: maxNodes }),
    ]);
    const edgeRows = await this.edges.listAmongNodes(snapshotId, selected.map((n) => n.id));

    const response = this.toGraphResponse(graphType, snapshotId, selected, edgeRows, totalNodes);
    await this.redis.set(key, JSON.stringify(response), "EX", this.config.GRAPH_CACHE_TTL_SECONDS);
    return response;
  }

  private toGraphResponse(graphType: GraphType, snapshotId: string, selected: GraphNodeRow[], edgeRows: GraphEdgeRow[], totalNodes: number): GraphResponse {
    const truncated = selected.length < totalNodes;
    return {
      graphType,
      snapshotId,
      nodes: selected.map(toNodeDto),
      edges: edgeRows.map(toEdgeDto),
      truncated,
      totalNodes,
      returnedNodes: selected.length,
      ...(truncated ? { strategy: "top-degree" as const, hint: "Filter by folder or expand from a node to see more." } : {}),
    };
  }

  /** No active snapshot yet (still indexing, or never completed) — the repository genuinely has no graph to show. */
  private async requireActiveSnapshot(repoId: string): Promise<string> {
    const repository = await this.repositories.getById(repoId);
    if (!repository.activeSnapshotId) {
      throw new AppError("GRAPH_NOT_BUILT", "This repository has not finished indexing yet.");
    }
    return repository.activeSnapshotId;
  }
}

function otherEndpoint(edge: GraphEdgeRow, frontier: string[]): string {
  return frontier.includes(edge.source_node_id) ? edge.target_node_id : edge.source_node_id;
}

function cacheKey(snapshotId: string, graphType: GraphType, filters: Record<string, unknown>): string {
  const parts = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  return `${CACHE_PREFIX}:${snapshotId}:${graphType}:${parts.join("&")}`;
}

function toNodeDto(row: GraphNodeRow): GraphNodeDto {
  return {
    id: row.id,
    type: row.node_type,
    label: row.label,
    path: row.path,
    metadata: { ...row.metadata, degree: row.degree, refId: row.ref_id },
  };
}

function toEdgeDto(row: GraphEdgeRow): GraphEdgeDto {
  return { id: row.id, source: row.source_node_id, target: row.target_node_id, type: row.edge_type };
}
