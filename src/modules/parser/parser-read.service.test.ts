import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { ParserReadService } from "./parser-read.service";

const getObjectStreamMock = vi.hoisted(() => vi.fn());
vi.mock("@aca/storage", async () => {
  const actual = await vi.importActual<typeof import("@aca/storage")>("@aca/storage");
  return { ...actual, getObjectStream: getObjectStreamMock };
});

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174001";
const FILE_ID = "123e4567-e89b-12d3-a456-426614174005";

const config = { S3_BUCKET: "aca-snapshots" } as IndexerEnv;

function fakeRepositoriesService(activeSnapshotId: string | null) {
  return { getById: vi.fn(async () => ({ repoId: REPO_ID, activeSnapshotId })) };
}

function fakeFilesRepository() {
  return { findById: vi.fn(), listBySnapshot: vi.fn(async () => []), listAllBySnapshot: vi.fn(async () => []) };
}

function fakeCodeSymbolsRepository() {
  return { listBySnapshot: vi.fn(async () => []), listAllBySnapshot: vi.fn(async () => []) };
}

function fakeFileDependenciesRepository() {
  return { listBySnapshot: vi.fn(async () => []) };
}

function buildService(overrides: {
  activeSnapshotId?: string | null;
  repositories?: ReturnType<typeof fakeRepositoriesService>;
  files?: ReturnType<typeof fakeFilesRepository>;
  codeSymbols?: ReturnType<typeof fakeCodeSymbolsRepository>;
  fileDependencies?: ReturnType<typeof fakeFileDependenciesRepository>;
} = {}) {
  const repositories = overrides.repositories ?? fakeRepositoriesService(overrides.activeSnapshotId ?? null);
  const files = overrides.files ?? fakeFilesRepository();
  const codeSymbols = overrides.codeSymbols ?? fakeCodeSymbolsRepository();
  const fileDependencies = overrides.fileDependencies ?? fakeFileDependenciesRepository();
  const service = new ParserReadService(
    config,
    {} as never,
    repositories as never,
    files as never,
    codeSymbols as never,
    fileDependencies as never
  );
  return { service, repositories, files, codeSymbols, fileDependencies };
}

beforeEach(() => getObjectStreamMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("ParserReadService.listFiles / listSymbols", () => {
  it("returns an empty page when the repository has no active snapshot yet", async () => {
    const { service, files } = buildService({ activeSnapshotId: null });

    const result = await service.listFiles(REPO_ID, { pageSize: 20 });

    expect(result).toEqual({ files: [], nextCursor: null });
    expect(files.listBySnapshot).not.toHaveBeenCalled();
  });

  it("maps rows to DTOs and sets nextCursor only when the page is full", async () => {
    const files = fakeFilesRepository();
    files.listBySnapshot.mockResolvedValueOnce([
      {
        id: FILE_ID,
        repo_id: REPO_ID,
        snapshot_id: SNAPSHOT_ID,
        path: "src/app.ts",
        directory: "src",
        extension: ".ts",
        language: "typescript",
        size_bytes: 42,
        line_count: 3,
        content_hash: "sha256:abc",
        object_key: `${REPO_ID}/${SNAPSHOT_ID}/files/${FILE_ID}`,
        created_at: new Date(),
      },
    ]);
    const { service } = buildService({ activeSnapshotId: SNAPSHOT_ID, files });

    const result = await service.listFiles(REPO_ID, { pageSize: 1 });

    expect(result.files).toEqual([
      expect.objectContaining({ fileId: FILE_ID, path: "src/app.ts", language: "typescript", lineCount: 3 }),
    ]);
    expect(result.nextCursor).not.toBeNull(); // page was full (1 row for pageSize 1)
    expect(files.listBySnapshot).toHaveBeenCalledWith({ snapshotId: SNAPSHOT_ID, pageSize: 1, cursor: null, pathPrefix: undefined });
  });

  it("decodes an opaque cursor back into the keyset filter", async () => {
    const { service, files } = buildService({ activeSnapshotId: SNAPSHOT_ID });
    const cursor = Buffer.from(JSON.stringify({ path: "src/app.ts", id: FILE_ID })).toString("base64url");

    await service.listFiles(REPO_ID, { pageSize: 20, cursor });

    expect(files.listBySnapshot).toHaveBeenCalledWith({
      snapshotId: SNAPSHOT_ID,
      pageSize: 20,
      cursor: { path: "src/app.ts", id: FILE_ID },
      pathPrefix: undefined,
    });
  });

  it("returns an empty symbols page with no active snapshot, without querying code_symbols", async () => {
    const { service, codeSymbols } = buildService({ activeSnapshotId: null });

    const result = await service.listSymbols(REPO_ID, { pageSize: 20 });

    expect(result).toEqual({ symbols: [], nextCursor: null });
    expect(codeSymbols.listBySnapshot).not.toHaveBeenCalled();
  });
});

describe("ParserReadService.getFile / getFileContent", () => {
  it("throws FILE_NOT_FOUND for an unknown file id", async () => {
    const files = fakeFilesRepository();
    files.findById.mockResolvedValueOnce(null);
    const { service } = buildService({ files });

    await expect(service.getFile(FILE_ID)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("returns the whole file when no line range is given", async () => {
    const files = fakeFilesRepository();
    files.findById.mockResolvedValue({
      id: FILE_ID,
      repo_id: REPO_ID,
      snapshot_id: SNAPSHOT_ID,
      path: "src/app.ts",
      directory: "src",
      extension: ".ts",
      language: "typescript",
      size_bytes: 30,
      line_count: 3,
      content_hash: "sha256:abc",
      object_key: `${REPO_ID}/${SNAPSHOT_ID}/files/${FILE_ID}`,
      created_at: new Date(),
    });
    getObjectStreamMock.mockResolvedValueOnce(Readable.from(["line1\nline2\nline3"]));
    const { service } = buildService({ files });

    const result = await service.getFileContent(FILE_ID, {});

    expect(result).toEqual({
      fileId: FILE_ID,
      path: "src/app.ts",
      language: "typescript",
      startLine: 1,
      endLine: 3,
      content: "line1\nline2\nline3",
    });
  });

  it("slices to the requested line range, clamped to the file's actual bounds", async () => {
    const files = fakeFilesRepository();
    files.findById.mockResolvedValue({
      id: FILE_ID,
      repo_id: REPO_ID,
      snapshot_id: SNAPSHOT_ID,
      path: "src/app.ts",
      directory: "src",
      extension: ".ts",
      language: "typescript",
      size_bytes: 30,
      line_count: 3,
      content_hash: "sha256:abc",
      object_key: `${REPO_ID}/${SNAPSHOT_ID}/files/${FILE_ID}`,
      created_at: new Date(),
    });
    getObjectStreamMock.mockResolvedValueOnce(Readable.from(["line1\nline2\nline3"]));
    const { service } = buildService({ files });

    const result = await service.getFileContent(FILE_ID, { startLine: 2, endLine: 999 });

    expect(result).toMatchObject({ startLine: 2, endLine: 3, content: "line2\nline3" });
  });
});

describe("ParserReadService bulk reads (internal, cross-module)", () => {
  it("listAllFilesForSnapshot delegates to the files repository's unpaginated query", async () => {
    const files = fakeFilesRepository();
    files.listAllBySnapshot.mockResolvedValueOnce([{ id: FILE_ID }]);
    const { service } = buildService({ files });

    const result = await service.listAllFilesForSnapshot(SNAPSHOT_ID);

    expect(files.listAllBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(result).toEqual([{ id: FILE_ID }]);
  });

  it("listAllSymbolsForSnapshot delegates to the symbols repository's unpaginated query", async () => {
    const codeSymbols = fakeCodeSymbolsRepository();
    codeSymbols.listAllBySnapshot.mockResolvedValueOnce([{ id: "sym-1" }]);
    const { service } = buildService({ codeSymbols });

    const result = await service.listAllSymbolsForSnapshot(SNAPSHOT_ID);

    expect(codeSymbols.listAllBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(result).toEqual([{ id: "sym-1" }]);
  });

  it("listAllDependenciesForSnapshot delegates to the file-dependencies repository", async () => {
    const fileDependencies = fakeFileDependenciesRepository();
    fileDependencies.listBySnapshot.mockResolvedValueOnce([{ id: "dep-1" }]);
    const { service } = buildService({ fileDependencies });

    const result = await service.listAllDependenciesForSnapshot(SNAPSHOT_ID);

    expect(fileDependencies.listBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(result).toEqual([{ id: "dep-1" }]);
  });
});
