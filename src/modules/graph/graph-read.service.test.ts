import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphResponseSchema, TreeResponseSchema } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { GraphReadService } from "./graph-read.service";

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174001";

const config = { GRAPH_QUERY_MAX_NODES: 1500, GRAPH_NEIGHBOR_MAX_DEPTH: 3, GRAPH_CACHE_TTL_SECONDS: 300 } as IndexerEnv;

function node(overrides: Partial<{ id: string; graph_type: string; node_type: string; label: string; path: string | null; degree: number; metadata: Record<string, unknown> }> = {}) {
  return {
    id: overrides.id ?? "node-1",
    repo_id: REPO_ID,
    snapshot_id: SNAPSHOT_ID,
    graph_type: overrides.graph_type ?? "folder",
    node_type: overrides.node_type ?? "file",
    label: overrides.label ?? "app.ts",
    path: overrides.path ?? "src/app.ts",
    ref_id: null,
    degree: overrides.degree ?? 0,
    metadata: overrides.metadata ?? {},
    created_at: new Date(),
  };
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    _store: store,
  };
}

function fakeRepositoriesService(activeSnapshotId: string | null) {
  return { getById: vi.fn(async () => ({ repoId: REPO_ID, activeSnapshotId })) };
}

function fakeNodesRepository() {
  return {
    countFiltered: vi.fn(async () => 0),
    listByGraphType: vi.fn(async () => []),
    findByIds: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    findByPath: vi.fn(async () => null),
    search: vi.fn(async () => []),
  };
}

function fakeEdgesRepository() {
  return {
    listAmongNodes: vi.fn(async () => []),
    listByNodeIds: vi.fn(async () => []),
  };
}

function buildService(overrides: {
  redis?: ReturnType<typeof fakeRedis>;
  repositories?: ReturnType<typeof fakeRepositoriesService>;
  nodes?: ReturnType<typeof fakeNodesRepository>;
  edges?: ReturnType<typeof fakeEdgesRepository>;
} = {}) {
  const redis = overrides.redis ?? fakeRedis();
  const repositories = overrides.repositories ?? fakeRepositoriesService(SNAPSHOT_ID);
  const nodes = overrides.nodes ?? fakeNodesRepository();
  const edges = overrides.edges ?? fakeEdgesRepository();
  const service = new GraphReadService(config, redis as never, repositories as never, nodes as never, edges as never);
  return { service, redis, repositories, nodes, edges };
}

afterEach(() => vi.clearAllMocks());

describe("GraphReadService — active snapshot scoping", () => {
  it("throws GRAPH_NOT_BUILT when the repository has no active snapshot yet", async () => {
    const { service } = buildService({ repositories: fakeRepositoriesService(null) });

    await expect(service.getFolders(REPO_ID, {})).rejects.toMatchObject({ code: "GRAPH_NOT_BUILT" });
  });
});

describe("GraphReadService — truncation", () => {
  it("reports truncated: false when every matching node is returned", async () => {
    const nodes = fakeNodesRepository();
    nodes.countFiltered.mockResolvedValue(1);
    nodes.listByGraphType.mockResolvedValue([node()]);
    const { service } = buildService({ nodes });

    const result = await service.getFolders(REPO_ID, {});

    expect(result).toMatchObject({ truncated: false, totalNodes: 1, returnedNodes: 1 });
    expect(result.strategy).toBeUndefined();
  });

  it("reports truncated: true with the top-degree strategy and a hint when the cap is hit", async () => {
    const nodes = fakeNodesRepository();
    nodes.countFiltered.mockResolvedValue(8241);
    nodes.listByGraphType.mockResolvedValue(Array.from({ length: 5 }, (_, i) => node({ id: `n${i}` })));
    const { service } = buildService({ nodes });

    const result = await service.getFolders(REPO_ID, { maxNodes: 5 });

    expect(result).toMatchObject({ truncated: true, totalNodes: 8241, returnedNodes: 5, strategy: "top-degree" });
    expect(result.hint).toBeTruthy();
    expect(nodes.listByGraphType).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it("excludes external_package nodes from the dependency graph when includeExternal=false", async () => {
    const nodes = fakeNodesRepository();
    const { service } = buildService({ nodes });

    await service.getDependencies(REPO_ID, { includeExternal: false });

    expect(nodes.countFiltered).toHaveBeenCalledWith(expect.objectContaining({ nodeTypes: ["file"] }));
    expect(nodes.listByGraphType).toHaveBeenCalledWith(expect.objectContaining({ nodeTypes: ["file"] }));
  });
});

describe("GraphReadService — caching", () => {
  it("caches a response keyed by snapshotId and serves the second call from cache", async () => {
    const nodes = fakeNodesRepository();
    nodes.countFiltered.mockResolvedValue(1);
    nodes.listByGraphType.mockResolvedValue([node()]);
    const { service, redis } = buildService({ nodes });

    await service.getFolders(REPO_ID, {});
    await service.getFolders(REPO_ID, {});

    expect(nodes.countFiltered).toHaveBeenCalledTimes(1); // second call served from cache
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect((redis.set.mock.calls[0]![0] as string)).toContain(SNAPSHOT_ID);
  });

  it("uses a different cache key for a different snapshot (cutover invalidates without an explicit purge)", async () => {
    const nodes = fakeNodesRepository();
    nodes.countFiltered.mockResolvedValue(1);
    nodes.listByGraphType.mockResolvedValue([node()]);
    const redis = fakeRedis();

    const { service: serviceBeforeCutover } = buildService({ nodes, redis, repositories: fakeRepositoriesService(SNAPSHOT_ID) });
    await serviceBeforeCutover.getFolders(REPO_ID, {});

    const NEW_SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174099";
    const { service: serviceAfterCutover } = buildService({ nodes, redis, repositories: fakeRepositoriesService(NEW_SNAPSHOT_ID) });
    await serviceAfterCutover.getFolders(REPO_ID, {});

    expect(nodes.countFiltered).toHaveBeenCalledTimes(2); // not served from the old snapshot's cache entry
  });
});

describe("GraphReadService.getTree", () => {
  it("returns a synthetic empty root for a repository with no files", async () => {
    const { service } = buildService();

    const result = await service.getTree(REPO_ID, { depth: 2 });

    expect(result.root).toMatchObject({ name: "/", path: "", type: "directory", children: [] });
  });

  it("throws NODE_NOT_FOUND for an explicit path that doesn't exist", async () => {
    const { service } = buildService();

    await expect(service.getTree(REPO_ID, { path: "missing", depth: 2 })).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });

  it("nests children up to the requested depth and marks a deeper directory as lazy via hasChildren", async () => {
    const root = node({ id: "root", node_type: "directory", path: "", label: "/" });
    const src = node({ id: "src", node_type: "directory", path: "src", label: "src" });
    const deep = node({ id: "deep", node_type: "directory", path: "src/deep", label: "deep" });
    const nodes = fakeNodesRepository();
    nodes.findByPath.mockResolvedValue(root);
    nodes.findByIds.mockImplementation(async (ids: string[]) => [src, deep].filter((n) => ids.includes(n.id)));

    const edges = fakeEdgesRepository();
    edges.listByNodeIds.mockImplementation(async ({ nodeIds }: { nodeIds: string[] }) => {
      if (nodeIds.includes("root")) return [{ id: "e1", source_node_id: "root", target_node_id: "src", edge_type: "contains" }];
      if (nodeIds.includes("src")) return [{ id: "e2", source_node_id: "src", target_node_id: "deep", edge_type: "contains" }];
      if (nodeIds.includes("deep")) return [{ id: "e3", source_node_id: "deep", target_node_id: "leaf", edge_type: "contains" }];
      return [];
    });

    const { service } = buildService({ nodes: nodes as never, edges: edges as never });

    // depth: 1 -> root expands (unconditional), src (depth budget 0 when it checks) reports hasChildren instead of expanding.
    const result = await service.getTree(REPO_ID, { path: "", depth: 1 });

    expect(result.root.children).toHaveLength(1);
    expect(result.root.children![0]).toMatchObject({ name: "src", hasChildren: true });
    expect(result.root.children![0]!.children).toBeUndefined();
  });
});

describe("GraphReadService.getNeighbors", () => {
  it("throws NODE_NOT_FOUND for a node outside the active snapshot", async () => {
    const nodes = fakeNodesRepository();
    nodes.findById.mockResolvedValue(node({ id: "other-snapshot-node" }));
    const { service } = buildService({ nodes, repositories: fakeRepositoriesService("different-snapshot") });

    await expect(service.getNeighbors(REPO_ID, "other-snapshot-node", { direction: "both" })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
  });

  it("always includes the root node itself even with zero neighbours", async () => {
    const root = node({ id: "root" });
    const nodes = fakeNodesRepository();
    nodes.findById.mockResolvedValue(root);
    const { service } = buildService({ nodes });

    const result = await service.getNeighbors(REPO_ID, "root", { direction: "both" });

    expect(result.nodes).toEqual([expect.objectContaining({ id: "root" })]);
    expect(result.truncated).toBe(false);
  });

  it("answers 'who imports this file' using direction: in, following the reverse index query shape", async () => {
    const root = node({ id: "target-file" });
    const importer = node({ id: "importer-file", label: "b.ts" });
    const nodes = fakeNodesRepository();
    nodes.findById.mockResolvedValue(root);
    nodes.findByIds.mockResolvedValue([importer]);
    const edges = fakeEdgesRepository();
    edges.listByNodeIds.mockImplementation(async (input: { direction: string }) => {
      expect(input.direction).toBe("in");
      return [{ id: "e1", source_node_id: "importer-file", target_node_id: "target-file", edge_type: "imports" }];
    });
    const { service } = buildService({ nodes: nodes as never, edges: edges as never });

    const result = await service.getNeighbors(REPO_ID, "target-file", { direction: "in" });

    expect(result.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["target-file", "importer-file"]));
  });
});

describe("GraphReadService.search", () => {
  it("returns nodes tagged with their graph type", async () => {
    const nodes = fakeNodesRepository();
    nodes.search.mockResolvedValue([node({ graph_type: "symbol", label: "Widget" })]);
    const { service } = buildService({ nodes });

    const result = await service.search(REPO_ID, { q: "widget" });

    expect(result.results).toEqual([expect.objectContaining({ graphType: "symbol", node: expect.objectContaining({ label: "Widget" }) })]);
  });
});

describe("GraphReadService — response contract conformance", () => {
  it("getFolders/getDependencies/getSymbols/getNeighbors all validate against GraphResponseSchema (the React Flow contract)", async () => {
    const NODE_ID = "123e4567-e89b-12d3-a456-426614174010";
    const EDGE_ID = "123e4567-e89b-12d3-a456-426614174011";
    const nodes = fakeNodesRepository();
    nodes.countFiltered.mockResolvedValue(1);
    nodes.listByGraphType.mockResolvedValue([node({ id: NODE_ID })]);
    nodes.findById.mockResolvedValue(node({ id: NODE_ID }));
    const edges = fakeEdgesRepository();
    edges.listAmongNodes.mockResolvedValue([{ id: EDGE_ID, source_node_id: NODE_ID, target_node_id: NODE_ID, edge_type: "contains" }]);
    const { service } = buildService({ nodes, edges });

    for (const response of [
      await service.getFolders(REPO_ID, {}),
      await service.getDependencies(REPO_ID, {}),
      await service.getSymbols(REPO_ID, {}),
      await service.getNeighbors(REPO_ID, NODE_ID, { direction: "both" }),
    ]) {
      expect(() => GraphResponseSchema.parse(response)).not.toThrow();
    }
  });

  it("getTree validates against TreeResponseSchema", async () => {
    const { service } = buildService();
    const result = await service.getTree(REPO_ID, { depth: 2 });
    expect(() => TreeResponseSchema.parse(result)).not.toThrow();
  });
});
