import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { AppError, type GraphType, type TypedEnvelope } from "@aca/contracts";
import { publishJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS } from "../../shared/infra.module";
import { ParserReadService } from "../parser/parser-read.service";
import { buildDependencyGraph } from "./builders/dependency-graph-builder";
import { buildFolderGraph } from "./builders/folder-graph-builder";
import type { BuiltGraph } from "./builders/graph-builder-types";
import { buildSymbolGraph } from "./builders/symbol-graph-builder";
import { GraphBuildStateRepository, type ReadyInput } from "./graph-build-state.repository";
import { GraphEdgesRepository, type InsertGraphEdgeInput } from "./graph-edges.repository";
import { GraphNodesRepository, type InsertGraphNodeInput } from "./graph-nodes.repository";

type TerminalEnvelope = TypedEnvelope<"repo.files.indexed" | "repo.symbols.extracted" | "repo.dependencies.extracted">;

interface GraphCounts {
  nodes: number;
  edges: number;
}

/**
 * Builds the three graphs once all three Parser terminal events have
 * arrived for a snapshot (GRAPH_SERVICE_PLAN.md "Build trigger — stated
 * explicitly"). Order-independent: whichever of the three handlers observes
 * all flags ready first performs the build, via `GraphBuildStateRepository`
 * `markReady` + `tryClaimBuild`'s atomic single-fire guard.
 */
@Injectable()
export class GraphBuilderService {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly buildState: GraphBuildStateRepository,
    private readonly nodes: GraphNodesRepository,
    private readonly edges: GraphEdgesRepository,
    private readonly parserRead: ParserReadService
  ) {}

  async handleFilesIndexed(envelope: TypedEnvelope<"repo.files.indexed">): Promise<void> {
    await this.handleTerminal(envelope, "files");
  }

  async handleSymbolsExtracted(envelope: TypedEnvelope<"repo.symbols.extracted">): Promise<void> {
    await this.handleTerminal(envelope, "symbols");
  }

  async handleDependenciesExtracted(envelope: TypedEnvelope<"repo.dependencies.extracted">): Promise<void> {
    await this.handleTerminal(envelope, "dependencies");
  }

  private async handleTerminal(envelope: TerminalEnvelope, which: ReadyInput): Promise<void> {
    const repoId = envelope.repoId;
    const snapshotId = envelope.snapshotId;
    if (!repoId || !snapshotId) {
      throw new Error(`Expected ${envelope.eventType} to carry repoId and snapshotId`);
    }
    if (envelope.payload.batchIndex !== envelope.payload.batchCount - 1) return; // wait for this input's own terminal batch

    await this.buildState.markReady(repoId, snapshotId, which);
    const claimed = await this.buildState.tryClaimBuild(snapshotId);
    if (!claimed) {
      this.logger.info({ repoId, snapshotId, which }, "recorded graph-build input, not all three ready yet");
      return;
    }

    try {
      await this.buildGraphs(repoId, snapshotId, envelope);
    } catch (err) {
      await this.buildState.releaseClaim(snapshotId);
      await this.handleFailure(repoId, snapshotId, envelope, err);
    }
  }

  private async buildGraphs(repoId: string, snapshotId: string, envelope: TerminalEnvelope): Promise<void> {
    const startedAt = Date.now();
    const [files, symbols, dependencies] = await Promise.all([
      this.parserRead.listAllFilesForSnapshot(snapshotId),
      this.parserRead.listAllSymbolsForSnapshot(snapshotId),
      this.parserRead.listAllDependenciesForSnapshot(snapshotId),
    ]);

    const folderFiles = files.map((f) => ({ id: f.id, path: f.path, language: f.language }));
    const folderGraph = buildFolderGraph(folderFiles);

    const dependencyGraph = buildDependencyGraph(
      folderFiles,
      dependencies.map((d) => ({
        sourceFileId: d.source_file_id,
        targetFileId: d.target_file_id,
        targetPath: d.target_path,
        externalPackage: d.external_package,
        rawSpecifier: d.raw_specifier,
        importKind: d.import_kind,
        resolutionStatus: d.resolution_status,
      }))
    );

    const symbolGraph = buildSymbolGraph(
      files.map((f) => ({ id: f.id, path: f.path })),
      symbols.map((s) => ({
        id: s.id,
        fileId: s.file_id,
        parentSymbolId: s.parent_symbol_id,
        symbolType: s.symbol_type,
        name: s.name,
        qualifiedName: s.qualified_name,
        isExported: s.is_exported,
        metadata: s.metadata,
      }))
    );

    // One delete for the whole snapshot up front — persistGraph below must not repeat it per graph type,
    // or a later graph type's insert would delete the earlier one's just-written rows.
    await this.nodes.deleteBySnapshot(snapshotId);
    await this.edges.deleteBySnapshot(snapshotId);

    const folderCounts = await this.persistGraph(repoId, snapshotId, "folder", folderGraph);
    const dependencyCounts = await this.persistGraph(repoId, snapshotId, "dependency", dependencyGraph);
    const symbolCounts = await this.persistGraph(repoId, snapshotId, "symbol", symbolGraph);

    const totalNodes = folderCounts.nodes + dependencyCounts.nodes + symbolCounts.nodes;

    await publishJob(this.boss, {
      eventType: "repo.graph.built",
      payload: {
        commitSha: envelope.payload.commitSha,
        graphs: { folder: folderCounts, dependency: dependencyCounts, symbol: symbolCounts },
        stage: "graphing",
        batchIndex: 0,
        batchCount: 1,
        itemsProcessed: totalNodes,
        totalItems: totalNodes,
        durationMs: Date.now() - startedAt,
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId,
      snapshotId,
    });
  }

  private async persistGraph(repoId: string, snapshotId: string, graphType: GraphType, graph: BuiltGraph): Promise<GraphCounts> {
    const nodeIdByKey = new Map<string, string>();
    const nodeRows: InsertGraphNodeInput[] = [];
    for (const [key, spec] of graph.nodes) {
      const id = randomUUID();
      nodeIdByKey.set(key, id);
      nodeRows.push({
        id,
        repoId,
        snapshotId,
        graphType,
        nodeType: spec.nodeType,
        label: spec.label,
        path: spec.path,
        refId: spec.refId,
        degree: spec.degree,
        metadata: spec.metadata,
      });
    }
    for (let i = 0; i < nodeRows.length; i += this.config.GRAPH_BUILD_BATCH_SIZE) {
      await this.nodes.insertBatch(nodeRows.slice(i, i + this.config.GRAPH_BUILD_BATCH_SIZE));
    }

    const edgeRows: InsertGraphEdgeInput[] = [];
    for (const edge of graph.edges) {
      const sourceNodeId = nodeIdByKey.get(edge.sourceKey);
      const targetNodeId = nodeIdByKey.get(edge.targetKey);
      if (!sourceNodeId || !targetNodeId) continue; // defensive — every builder only ever references keys it created itself
      edgeRows.push({ id: randomUUID(), repoId, snapshotId, graphType, sourceNodeId, targetNodeId, edgeType: edge.edgeType });
    }
    for (let i = 0; i < edgeRows.length; i += this.config.GRAPH_BUILD_BATCH_SIZE) {
      await this.edges.insertBatch(edgeRows.slice(i, i + this.config.GRAPH_BUILD_BATCH_SIZE));
    }

    return { nodes: nodeRows.length, edges: edgeRows.length };
  }

  private async handleFailure(repoId: string, snapshotId: string, envelope: TerminalEnvelope, err: unknown): Promise<void> {
    const appError =
      err instanceof AppError ? err : new AppError("GRAPH_BUILD_FAILED", "Building the repository graphs failed.", { cause: err });

    this.logger.error({ err: appError, repoId, snapshotId }, "graph build failed");

    await publishJob(this.boss, {
      eventType: "repo.stage.failed",
      payload: {
        stage: "graphing",
        errorCode: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        detail: {},
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId,
      snapshotId,
    });
  }
}
