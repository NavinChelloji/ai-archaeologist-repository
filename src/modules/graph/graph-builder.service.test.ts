import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { GraphBuilderService } from "./graph-builder.service";

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174001";
const USER_ID = "123e4567-e89b-12d3-a456-426614174002";
const CORRELATION_ID = "123e4567-e89b-12d3-a456-426614174003";

const config = { GRAPH_BUILD_BATCH_SIZE: 2000 } as IndexerEnv;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function terminalEnvelope(eventType: "repo.files.indexed" | "repo.symbols.extracted" | "repo.dependencies.extracted") {
  return {
    eventId: `${eventType}-event`,
    eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: CORRELATION_ID,
    causationId: null,
    userId: USER_ID,
    repoId: REPO_ID,
    snapshotId: SNAPSHOT_ID,
    retryCount: 0,
    payload: {
      commitSha: "abc123",
      stage: "extracting",
      batchIndex: 0,
      batchCount: 1,
      itemsProcessed: 1,
      totalItems: 1,
      durationMs: 5,
    },
  } as unknown as TypedEnvelope<typeof eventType>;
}

/** Mimics graph_build_state's atomic markReady/tryClaimBuild/releaseClaim semantics closely enough to test the service's orchestration logic (JS is single-threaded, so "atomic" here just means correctly sequenced). */
function fakeBuildState() {
  const rows = new Map<string, { files: boolean; symbols: boolean; dependencies: boolean; built: boolean }>();
  return {
    markReady: vi.fn(async (_repoId: string, snapshotId: string, which: "files" | "symbols" | "dependencies") => {
      const row = rows.get(snapshotId) ?? { files: false, symbols: false, dependencies: false, built: false };
      row[which] = true;
      rows.set(snapshotId, row);
      return row;
    }),
    tryClaimBuild: vi.fn(async (snapshotId: string) => {
      const row = rows.get(snapshotId);
      if (!row || !row.files || !row.symbols || !row.dependencies || row.built) return false;
      row.built = true;
      return true;
    }),
    releaseClaim: vi.fn(async (snapshotId: string) => {
      const row = rows.get(snapshotId);
      if (row) row.built = false;
    }),
  };
}

function fakeNodesRepository() {
  return { deleteBySnapshot: vi.fn(async () => undefined), insertBatch: vi.fn(async () => undefined) };
}

function fakeEdgesRepository() {
  return { deleteBySnapshot: vi.fn(async () => undefined), insertBatch: vi.fn(async () => undefined) };
}

function fakeParserRead(overrides: { files?: unknown[]; symbols?: unknown[]; dependencies?: unknown[] } = {}) {
  return {
    listAllFilesForSnapshot: vi.fn(async () => overrides.files ?? []),
    listAllSymbolsForSnapshot: vi.fn(async () => overrides.symbols ?? []),
    listAllDependenciesForSnapshot: vi.fn(async () => overrides.dependencies ?? []),
  };
}

function buildService(overrides: {
  buildState?: ReturnType<typeof fakeBuildState>;
  nodes?: ReturnType<typeof fakeNodesRepository>;
  edges?: ReturnType<typeof fakeEdgesRepository>;
  parserRead?: ReturnType<typeof fakeParserRead>;
} = {}) {
  const boss = { send: vi.fn().mockResolvedValue("job-1") };
  const buildState = overrides.buildState ?? fakeBuildState();
  const nodes = overrides.nodes ?? fakeNodesRepository();
  const edges = overrides.edges ?? fakeEdgesRepository();
  const parserRead = overrides.parserRead ?? fakeParserRead();
  const service = new GraphBuilderService(
    boss as never,
    config,
    logger,
    buildState as never,
    nodes as never,
    edges as never,
    parserRead as never
  );
  return { service, boss, buildState, nodes, edges, parserRead };
}

function findPublished(boss: { send: ReturnType<typeof vi.fn> }, eventType: string) {
  return boss.send.mock.calls.find((call: unknown[]) => call[0] === eventType);
}

afterEach(() => vi.clearAllMocks());

describe("GraphBuilderService — arrival tracking", () => {
  it("does not build until all three terminal inputs have arrived", async () => {
    const { service, boss, nodes } = buildService();

    await service.handleFilesIndexed(terminalEnvelope("repo.files.indexed"));
    await service.handleSymbolsExtracted(terminalEnvelope("repo.symbols.extracted"));

    expect(nodes.insertBatch).not.toHaveBeenCalled();
    expect(findPublished(boss, "repo.graph.built")).toBeUndefined();
  });

  it("builds exactly once regardless of arrival order", async () => {
    const { service, boss, nodes } = buildService();

    // Deliberately out of the files -> symbols -> dependencies order.
    await service.handleDependenciesExtracted(terminalEnvelope("repo.dependencies.extracted"));
    await service.handleFilesIndexed(terminalEnvelope("repo.files.indexed"));
    await service.handleSymbolsExtracted(terminalEnvelope("repo.symbols.extracted"));

    expect(nodes.deleteBySnapshot).toHaveBeenCalledTimes(1);
    expect(findPublished(boss, "repo.graph.built")).toBeTruthy();
    expect(boss.send.mock.calls.filter((c) => c[0] === "repo.graph.built")).toHaveLength(1);
  });

  it("ignores a non-terminal (mid-batch) delivery", async () => {
    const { service, buildState } = buildService();
    const envelope = terminalEnvelope("repo.files.indexed");
    (envelope.payload as { batchIndex: number; batchCount: number }).batchIndex = 0;
    (envelope.payload as { batchIndex: number; batchCount: number }).batchCount = 2;

    await service.handleFilesIndexed(envelope);

    expect(buildState.markReady).not.toHaveBeenCalled();
  });
});

describe("GraphBuilderService — build and persist", () => {
  it("builds all three graphs from Parser's data and publishes counts", async () => {
    const parserRead = fakeParserRead({
      files: [{ id: "f1", path: "src/app.ts", language: "typescript" }],
      symbols: [
        { id: "s1", file_id: "f1", parent_symbol_id: null, symbol_type: "function", name: "run", qualified_name: "run", is_exported: true, metadata: {} },
      ],
      dependencies: [],
    });
    const { service, boss, nodes, edges } = buildService({ parserRead });

    await service.handleFilesIndexed(terminalEnvelope("repo.files.indexed"));
    await service.handleSymbolsExtracted(terminalEnvelope("repo.symbols.extracted"));
    await service.handleDependenciesExtracted(terminalEnvelope("repo.dependencies.extracted"));

    expect(nodes.deleteBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(edges.deleteBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    // insertBatch called once per graph type that has nodes (folder: dir+file, dependency: file, symbol: file+function)
    expect(nodes.insertBatch.mock.calls.length).toBeGreaterThanOrEqual(3);

    const built = findPublished(boss, "repo.graph.built");
    expect(built).toBeTruthy();
    const payload = built![1].payload;
    expect(payload).toMatchObject({
      commitSha: "abc123",
      stage: "graphing",
      batchIndex: 0,
      batchCount: 1,
    });
    expect(payload.graphs.folder.nodes).toBeGreaterThan(0);
    expect(payload.graphs.symbol.nodes).toBeGreaterThan(0);
  });

  it("releases the claim and publishes repo.stage.failed with stage graphing on build failure", async () => {
    const nodes = fakeNodesRepository();
    nodes.insertBatch.mockRejectedValueOnce(new Error("db exploded"));
    const parserRead = fakeParserRead({ files: [{ id: "f1", path: "src/app.ts", language: "typescript" }] });
    const { service, boss, buildState } = buildService({ nodes, parserRead });

    await service.handleFilesIndexed(terminalEnvelope("repo.files.indexed"));
    await service.handleSymbolsExtracted(terminalEnvelope("repo.symbols.extracted"));
    await service.handleDependenciesExtracted(terminalEnvelope("repo.dependencies.extracted"));

    expect(buildState.releaseClaim).toHaveBeenCalledWith(SNAPSHOT_ID);
    const failure = findPublished(boss, "repo.stage.failed");
    expect(failure![1].payload).toMatchObject({ stage: "graphing", errorCode: "GRAPH_BUILD_FAILED" });
  });
});
