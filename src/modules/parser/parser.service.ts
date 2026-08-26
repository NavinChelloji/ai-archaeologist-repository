import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { AppError, type ProcessingStage, type TypedEnvelope } from "@aca/contracts";
import { publishJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { fileObjectKey, getObjectStream, manifestObjectKey, putObject, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS, S3_CLIENT } from "../../shared/infra.module";
import { SnapshotsService } from "../repositories/snapshots.service";
import { PARSER_WORKER_POOL, type AstParserPool } from "./ast-workers/worker-pool";
import { SYMBOL_TYPES, type SymbolType } from "./ast-extractor";
import { CodeSymbolsRepository, type InsertCodeSymbolInput } from "./code-symbols.repository";
import { FileDependenciesRepository, type InsertFileDependencyInput } from "./file-dependencies.repository";
import { RESOLUTION_STATUSES, resolveImport, type ResolutionContext, type ResolutionStatus } from "./import-resolver";
import { isIgnoredFilename, isIgnoredPath, isSecretFile, looksBinary, looksGenerated, type SkipReason } from "./ignore-rules";
import { detectLanguage, TYPESCRIPT_JAVASCRIPT_LANGUAGES } from "./language";
import { RepositoryFilesRepository, type InsertRepositoryFileInput } from "./repository-files.repository";
import { safeExtract } from "./safe-extractor";
import { stripArchiveRootPrefix } from "./strip-archive-root";
import { discoverWorkspacePackages } from "./workspace-packages";

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
/** Keeps each multi-row INSERT well under Postgres's 65535 bound-parameter limit. */
const DB_INSERT_BATCH_SIZE = 500;
const TSCONFIG_FILENAME_PATTERN = /tsconfig.*\.json$/i;

interface ManifestFileEntry {
  fileId: string;
  path: string;
  language: string | null;
  sizeBytes: number;
  lineCount: number;
  contentHash: string;
  objectKey: string;
}

interface TsJsFile {
  fileId: string;
  relativePath: string;
  content: string;
}

/**
 * Reacts to `repo.snapshot.created` on this module's own fan-out queue
 * (Pipeline consumes the same event, separately, for bookkeeping).
 * Downloads the archive from S3, safely extracts it, filters it, writes
 * per-file text and a manifest back to S3, records the inventory, and
 * publishes `repo.files.indexed` — then, for TypeScript/JavaScript files,
 * parses symbols and imports, resolves imports, and publishes
 * `repo.symbols.extracted` / `repo.dependencies.extracted`
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md flow chart).
 *
 * `repo.files.indexed` is published *before* the parsing phase runs, and
 * deliberately not after: Pipeline only accepts `repo.symbols.extracted` /
 * `repo.dependencies.extracted` once it has processed `repo.files.indexed`
 * and advanced the job into the "parsing" stage (see `matchActiveJob` in
 * pipeline.service.ts). The AST parsing phase's own processing time is the
 * ordering margin between the two — the same margin the existing
 * extracting/parsing boundary already relies on between `repo.snapshot.created`
 * and `repo.files.indexed`.
 */
@Injectable()
export class ParserService {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly files: RepositoryFilesRepository,
    private readonly snapshots: SnapshotsService,
    @Inject(PARSER_WORKER_POOL) private readonly pool: AstParserPool,
    private readonly codeSymbols: CodeSymbolsRepository,
    private readonly fileDependencies: FileDependenciesRepository
  ) {}

  async handleSnapshotCreated(envelope: TypedEnvelope<"repo.snapshot.created">): Promise<void> {
    const repoId = envelope.repoId;
    const snapshotId = envelope.snapshotId;
    if (!repoId || !snapshotId) {
      throw new Error("Expected repo.snapshot.created to carry repoId and snapshotId");
    }

    const startedAt = Date.now();
    let tempDir: string | null = null;
    let currentStage: ProcessingStage = "extracting";
    try {
      await mkdir(this.config.TEMP_WORK_DIR, { recursive: true });
      tempDir = await mkdtemp(join(this.config.TEMP_WORK_DIR, "extract-"));

      const archiveStream = await getObjectStream(this.s3, this.config.S3_BUCKET, envelope.payload.archiveKey);
      const extracted = await safeExtract({
        archiveStream,
        destDir: tempDir,
        maxFileSizeBytes: this.config.MAX_FILE_SIZE_KB * BYTES_PER_KB,
        maxExtractedSizeBytes: this.config.MAX_EXTRACTED_SIZE_MB * BYTES_PER_MB,
        maxFiles: this.config.MAX_FILES_PER_REPO,
        maxDirectoryDepth: this.config.MAX_DIRECTORY_DEPTH,
      });

      const strippedPaths = stripArchiveRootPrefix(extracted.files.map((file) => file.path));

      const skippedReasons: Record<SkipReason, number> = {
        ignored: extracted.skippedTooDeep,
        binary: 0,
        too_large: extracted.skippedTooLarge,
        excluded_secret: 0,
        generated: 0,
      };
      const languages: Record<string, number> = {};
      const manifestEntries: ManifestFileEntry[] = [];
      const dbRows: InsertRepositoryFileInput[] = [];
      const tsJsFiles: TsJsFile[] = [];
      const packageJsonContents = new Map<string, string>();
      const tsconfigContents = new Map<string, string>();
      let pnpmWorkspaceYaml: string | null = null;

      for (const extractedFile of extracted.files) {
        const relativePath = strippedPaths.get(extractedFile.path) ?? extractedFile.path;
        if (relativePath === "") continue; // the archive's own wrapper-directory entry

        const segments = relativePath.split("/");
        const filename = segments[segments.length - 1]!;

        if (isIgnoredPath(segments) || isIgnoredFilename(filename)) {
          skippedReasons.ignored += 1;
          continue;
        }
        if (isSecretFile(filename)) {
          skippedReasons.excluded_secret += 1;
          continue;
        }

        const content = await readFile(extractedFile.absolutePath);
        if (looksBinary(content)) {
          skippedReasons.binary += 1;
          continue;
        }
        if (looksGenerated(content)) {
          skippedReasons.generated += 1;
          continue;
        }

        const language = detectLanguage(relativePath);
        if (language) languages[language] = (languages[language] ?? 0) + 1;

        const fileId = randomUUID();
        const objectKey = fileObjectKey(repoId, snapshotId, fileId);
        const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
        const lineCount = countLines(content);
        const directoryPath = dirname(relativePath);
        const extension = extname(relativePath) || null;

        await putObject(this.s3, {
          bucket: this.config.S3_BUCKET,
          key: objectKey,
          body: content,
          contentType: "text/plain; charset=utf-8",
          contentLength: content.length,
        });

        manifestEntries.push({ fileId, path: relativePath, language, sizeBytes: content.length, lineCount, contentHash, objectKey });
        dbRows.push({
          id: fileId,
          repoId,
          snapshotId,
          path: relativePath,
          directory: directoryPath === "." ? "" : directoryPath,
          extension,
          language,
          sizeBytes: content.length,
          lineCount,
          contentHash,
          objectKey,
        });

        if (language && TYPESCRIPT_JAVASCRIPT_LANGUAGES.has(language)) {
          tsJsFiles.push({ fileId, relativePath, content: content.toString("utf8") });
        }
        if (filename === "package.json") {
          packageJsonContents.set(relativePath, content.toString("utf8"));
        } else if (TSCONFIG_FILENAME_PATTERN.test(filename)) {
          tsconfigContents.set(relativePath, content.toString("utf8"));
        } else if (relativePath === "pnpm-workspace.yaml") {
          pnpmWorkspaceYaml = content.toString("utf8");
        }
      }

      if (dbRows.length === 0) {
        throw new AppError("REPO_EMPTY", "No indexable files remain in this repository after filtering.");
      }

      const manifestKey = manifestObjectKey(repoId, snapshotId);
      const manifest = {
        repoId,
        snapshotId,
        commitSha: envelope.payload.commitSha,
        generatedAt: new Date().toISOString(),
        files: manifestEntries,
      };
      await putObject(this.s3, {
        bucket: this.config.S3_BUCKET,
        key: manifestKey,
        body: Buffer.from(JSON.stringify(manifest)),
        contentType: "application/json",
      });

      for (let i = 0; i < dbRows.length; i += DB_INSERT_BATCH_SIZE) {
        await this.files.insertBatch(dbRows.slice(i, i + DB_INSERT_BATCH_SIZE));
      }
      await this.snapshots.recordManifest(snapshotId, { manifestKey, fileCount: dbRows.length });

      const skippedCount = Object.values(skippedReasons).reduce((sum, count) => sum + count, 0);
      await publishJob(this.boss, {
        eventType: "repo.files.indexed",
        payload: {
          commitSha: envelope.payload.commitSha,
          manifestKey,
          fileCount: dbRows.length,
          skippedCount,
          skippedReasons,
          languages,
          stage: "extracting",
          batchIndex: 0,
          batchCount: 1,
          itemsProcessed: dbRows.length,
          totalItems: dbRows.length,
          durationMs: Date.now() - startedAt,
        },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        userId: envelope.userId,
        repoId,
        snapshotId,
      });
      currentStage = "parsing";

      await this.extractSymbolsAndDependencies(envelope, {
        repoId,
        snapshotId,
        dbRows,
        tsJsFiles,
        packageJsonContents,
        tsconfigContents,
        pnpmWorkspaceYaml,
        startedAt,
      });
    } catch (err) {
      await this.handleFailure(envelope, err, currentStage);
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  private async extractSymbolsAndDependencies(
    envelope: TypedEnvelope<"repo.snapshot.created">,
    ctx: {
      repoId: string;
      snapshotId: string;
      dbRows: InsertRepositoryFileInput[];
      tsJsFiles: TsJsFile[];
      packageJsonContents: Map<string, string>;
      tsconfigContents: Map<string, string>;
      pnpmWorkspaceYaml: string | null;
      startedAt: number;
    }
  ): Promise<void> {
    const { repoId, snapshotId, dbRows, tsJsFiles, packageJsonContents, tsconfigContents, pnpmWorkspaceYaml, startedAt } = ctx;

    if (tsJsFiles.length === 0) {
      await this.publishParsingTerminals(
        envelope,
        repoId,
        snapshotId,
        { symbolCount: 0, byType: zeroed(SYMBOL_TYPES), languageSupported: false },
        { edgeCount: 0, byResolution: zeroed(RESOLUTION_STATUSES), languageSupported: false },
        startedAt
      );
      return;
    }

    const pathSet = new Set(dbRows.map((r) => r.path));
    const pathToFileId = new Map(dbRows.map((r) => [r.path, r.id]));
    const workspacePackages = discoverWorkspacePackages(packageJsonContents, pnpmWorkspaceYaml);
    const resolutionCtx: ResolutionContext = { pathSet, workspacePackages, packageJsonContents, tsconfigContents };

    const outcomes = await Promise.all(
      tsJsFiles.map((file) =>
        this.pool.parse({ relativePath: file.relativePath, language: detectLanguage(file.relativePath)!, content: file.content })
      )
    );

    const symbolRows: InsertCodeSymbolInput[] = [];
    const dependencyRows: InsertFileDependencyInput[] = [];
    const byType = zeroed(SYMBOL_TYPES);
    const byResolution = zeroed(RESOLUTION_STATUSES);

    for (let i = 0; i < tsJsFiles.length; i += 1) {
      const file = tsJsFiles[i]!;
      const outcome = outcomes[i]!;
      if (!outcome.result) {
        this.logger.warn({ repoId, snapshotId, path: file.relativePath, error: outcome.error }, "skipping file: AST parse failed or timed out");
        continue;
      }

      const localIdByIndex = new Map<number, string>();
      for (let s = 0; s < outcome.result.symbols.length; s += 1) {
        const raw = outcome.result.symbols[s]!;
        const id = randomUUID();
        localIdByIndex.set(s, id);
        const parentSymbolId = raw.parentIndex !== null ? (localIdByIndex.get(raw.parentIndex) ?? null) : null;
        symbolRows.push({
          id,
          repoId,
          snapshotId,
          fileId: file.fileId,
          parentSymbolId,
          symbolType: raw.symbolType,
          name: raw.name,
          qualifiedName: raw.qualifiedName,
          signature: raw.signature,
          isExported: raw.isExported,
          startLine: raw.startLine,
          endLine: raw.endLine,
          metadata: raw.heritage ? { extends: raw.heritage.extendsNames, implements: raw.heritage.implementsNames } : {},
        });
        byType[raw.symbolType] += 1;
      }

      for (const raw of outcome.result.imports) {
        const id = randomUUID();
        if (raw.kind === "dynamic" && !raw.isLiteralSpecifier) {
          dependencyRows.push({
            id,
            repoId,
            snapshotId,
            sourceFileId: file.fileId,
            targetFileId: null,
            targetPath: null,
            externalPackage: null,
            rawSpecifier: raw.specifier,
            importKind: raw.kind,
            resolutionStatus: "dynamic_unresolvable",
            line: raw.line,
          });
          byResolution.dynamic_unresolvable += 1;
          continue;
        }

        const resolved = resolveImport(raw.specifier, file.relativePath, resolutionCtx);
        dependencyRows.push({
          id,
          repoId,
          snapshotId,
          sourceFileId: file.fileId,
          targetFileId: resolved.targetPath ? (pathToFileId.get(resolved.targetPath) ?? null) : null,
          targetPath: resolved.targetPath,
          externalPackage: resolved.externalPackage,
          rawSpecifier: raw.specifier,
          importKind: raw.kind,
          resolutionStatus: resolved.status,
          line: raw.line,
        });
        byResolution[resolved.status] += 1;
      }
    }

    await this.codeSymbols.deleteBySnapshot(snapshotId);
    for (let i = 0; i < symbolRows.length; i += this.config.PARSER_BATCH_SIZE) {
      await this.codeSymbols.insertBatch(symbolRows.slice(i, i + this.config.PARSER_BATCH_SIZE));
    }
    await this.fileDependencies.deleteBySnapshot(snapshotId);
    for (let i = 0; i < dependencyRows.length; i += this.config.PARSER_BATCH_SIZE) {
      await this.fileDependencies.insertBatch(dependencyRows.slice(i, i + this.config.PARSER_BATCH_SIZE));
    }

    await this.publishParsingTerminals(
      envelope,
      repoId,
      snapshotId,
      { symbolCount: symbolRows.length, byType, languageSupported: true },
      { edgeCount: dependencyRows.length, byResolution, languageSupported: true },
      startedAt
    );
  }

  private async publishParsingTerminals(
    envelope: TypedEnvelope<"repo.snapshot.created">,
    repoId: string,
    snapshotId: string,
    symbols: { symbolCount: number; byType: Record<SymbolType, number>; languageSupported: boolean },
    dependencies: { edgeCount: number; byResolution: Record<ResolutionStatus, number>; languageSupported: boolean },
    startedAt: number
  ): Promise<void> {
    const base = {
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId,
      snapshotId,
    };
    const progress = {
      stage: "parsing" as const,
      batchIndex: 0,
      batchCount: 1,
      durationMs: Date.now() - startedAt,
    };

    await publishJob(this.boss, {
      eventType: "repo.symbols.extracted",
      payload: {
        commitSha: envelope.payload.commitSha,
        symbolCount: symbols.symbolCount,
        languageSupported: symbols.languageSupported,
        byType: symbols.byType,
        itemsProcessed: symbols.symbolCount,
        totalItems: symbols.symbolCount,
        ...progress,
      },
      ...base,
    });

    await publishJob(this.boss, {
      eventType: "repo.dependencies.extracted",
      payload: {
        commitSha: envelope.payload.commitSha,
        edgeCount: dependencies.edgeCount,
        languageSupported: dependencies.languageSupported,
        byResolution: dependencies.byResolution,
        itemsProcessed: dependencies.edgeCount,
        totalItems: dependencies.edgeCount,
        ...progress,
      },
      ...base,
    });
  }

  private async handleFailure(envelope: TypedEnvelope<"repo.snapshot.created">, err: unknown, stage: ProcessingStage): Promise<void> {
    const appError =
      err instanceof AppError ? err : new AppError("PARSE_FAILED", "Extracting the repository snapshot failed.", { cause: err });

    this.logger.error({ err: appError, repoId: envelope.repoId, snapshotId: envelope.snapshotId, stage }, "parser stage failed");

    await publishJob(this.boss, {
      eventType: "repo.stage.failed",
      payload: {
        stage,
        errorCode: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        detail: {},
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId: envelope.repoId,
      snapshotId: envelope.snapshotId,
    });
  }
}

function zeroed<T extends string>(keys: readonly T[]): Record<T, number> {
  const record = {} as Record<T, number>;
  for (const key of keys) record[key] = 0;
  return record;
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (const byte of content) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}
