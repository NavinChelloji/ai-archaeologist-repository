import { buffer as consumeToBuffer } from "node:stream/consumers";
import { Inject, Injectable } from "@nestjs/common";
import {
  AppError,
  type CodeSymbolDto,
  type InternalFileContentQuery,
  type InternalFileContentResponse,
  type InternalRepositoryFilesQuery,
  type InternalRepositoryFilesResponse,
  type InternalRepositorySymbolsQuery,
  type InternalRepositorySymbolsResponse,
  type RepositoryFileDto,
} from "@aca/contracts";
import { getObjectStream, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { S3_CLIENT } from "../../shared/infra.module";
import { RepositoriesService } from "../repositories/repositories.service";
import { CodeSymbolsRepository, type CodeSymbolRow } from "./code-symbols.repository";
import { FileDependenciesRepository, type FileDependencyRow } from "./file-dependencies.repository";
import { decodeListCursor, encodeListCursor } from "./list-cursor";
import { RepositoryFilesRepository, type RepositoryFileRow } from "./repository-files.repository";

/**
 * The read side of the Parser module (REPOSITORY_PROCESSOR_SERVICE_PLAN.md
 * "APIs"). Every list is implicitly scoped to the repository's *active*
 * snapshot (CODEBASE.md "One active snapshot per repository") — callers
 * only ever name the repository, never a snapshot.
 */
@Injectable()
export class ParserReadService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly repositories: RepositoriesService,
    private readonly files: RepositoryFilesRepository,
    private readonly codeSymbols: CodeSymbolsRepository,
    private readonly fileDependencies: FileDependenciesRepository
  ) {}

  async listFiles(repoId: string, query: InternalRepositoryFilesQuery): Promise<InternalRepositoryFilesResponse> {
    const snapshotId = await this.getActiveSnapshotId(repoId);
    if (!snapshotId) return { files: [], nextCursor: null };
    const cursor = query.cursor ? decodeListCursor<{ path: string; id: string }>(query.cursor) : null;

    const rows = await this.files.listBySnapshot({ snapshotId, pageSize: query.pageSize, cursor, pathPrefix: query.path });
    const nextCursor = rows.length === query.pageSize ? encodeListCursor(pick(rows[rows.length - 1]!, "path", "id")) : null;

    return { files: rows.map(toFileDto), nextCursor };
  }

  async getFile(fileId: string): Promise<RepositoryFileDto> {
    const row = await this.files.findById(fileId);
    if (!row) throw new AppError("FILE_NOT_FOUND", "This file does not exist.");
    return toFileDto(row);
  }

  async getFileContent(fileId: string, query: InternalFileContentQuery): Promise<InternalFileContentResponse> {
    const file = await this.files.findById(fileId);
    if (!file) throw new AppError("FILE_NOT_FOUND", "This file does not exist.");

    const stream = await getObjectStream(this.s3, this.config.S3_BUCKET, file.object_key);
    const text = (await consumeToBuffer(stream)).toString("utf8");
    const lines = text.length === 0 ? [] : text.split("\n");

    const startLine = clamp(query.startLine ?? 1, 1, Math.max(lines.length, 1));
    const endLine = clamp(query.endLine ?? lines.length, startLine, Math.max(lines.length, 1));

    return {
      fileId: file.id,
      path: file.path,
      language: file.language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
    };
  }

  async listSymbols(repoId: string, query: InternalRepositorySymbolsQuery): Promise<InternalRepositorySymbolsResponse> {
    const snapshotId = await this.getActiveSnapshotId(repoId);
    if (!snapshotId) return { symbols: [], nextCursor: null };
    const cursor = query.cursor ? decodeListCursor<{ name: string; id: string }>(query.cursor) : null;

    const rows = await this.codeSymbols.listBySnapshot({
      snapshotId,
      pageSize: query.pageSize,
      cursor,
      type: query.type,
      namePrefix: query.name,
    });
    const nextCursor = rows.length === query.pageSize ? encodeListCursor(pick(rows[rows.length - 1]!, "name", "id")) : null;

    return { symbols: rows.map(toSymbolDto), nextCursor };
  }

  /** No active snapshot yet (still indexing, or never completed) reads as an empty page, not an error. */
  private async getActiveSnapshotId(repoId: string): Promise<string | null> {
    const repository = await this.repositories.getById(repoId);
    return repository.activeSnapshotId;
  }

  // -- Internal bulk reads for other modules (the Graph module's builders) — unpaginated, RULES.md module-boundary
  // compliant: they go through this service rather than reaching into Parser's repositories directly. --

  async listAllFilesForSnapshot(snapshotId: string): Promise<RepositoryFileRow[]> {
    return this.files.listAllBySnapshot(snapshotId);
  }

  async listAllSymbolsForSnapshot(snapshotId: string): Promise<CodeSymbolRow[]> {
    return this.codeSymbols.listAllBySnapshot(snapshotId);
  }

  async listAllDependenciesForSnapshot(snapshotId: string): Promise<FileDependencyRow[]> {
    return this.fileDependencies.listBySnapshot(snapshotId);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pick<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = obj[key];
  return result;
}

function toFileDto(row: RepositoryFileRow): RepositoryFileDto {
  return {
    fileId: row.id,
    repoId: row.repo_id,
    snapshotId: row.snapshot_id,
    path: row.path,
    directory: row.directory,
    extension: row.extension,
    language: row.language,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    contentHash: row.content_hash,
  };
}

function toSymbolDto(row: CodeSymbolRow): CodeSymbolDto {
  return {
    symbolId: row.id,
    repoId: row.repo_id,
    snapshotId: row.snapshot_id,
    fileId: row.file_id,
    parentSymbolId: row.parent_symbol_id,
    symbolType: row.symbol_type,
    name: row.name,
    qualifiedName: row.qualified_name,
    signature: row.signature,
    isExported: row.is_exported,
    startLine: row.start_line,
    endLine: row.end_line,
  };
}
