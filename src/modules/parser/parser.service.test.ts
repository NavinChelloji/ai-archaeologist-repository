import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { LANGUAGE_PARSERS } from "./ast-extractor";
import type { AstParserPool, ParseOutcome, ParseTask } from "./ast-workers/worker-pool";
import { ParserService } from "./parser.service";
import { buildTarGz } from "./test-support";

const putObjectMock = vi.hoisted(() => vi.fn(async () => undefined));
const getObjectStreamMock = vi.hoisted(() => vi.fn());
vi.mock("@aca/storage", async () => {
  const actual = await vi.importActual<typeof import("@aca/storage")>("@aca/storage");
  return { ...actual, putObject: putObjectMock, getObjectStream: getObjectStreamMock };
});

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const SNAPSHOT_ID = "123e4567-e89b-12d3-a456-426614174001";
const USER_ID = "123e4567-e89b-12d3-a456-426614174002";
const CORRELATION_ID = "123e4567-e89b-12d3-a456-426614174003";
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174004";

function envelope(): TypedEnvelope<"repo.snapshot.created"> {
  return {
    eventId: EVENT_ID,
    eventType: "repo.snapshot.created",
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
      ref: "main",
      archiveKey: `${REPO_ID}/${SNAPSHOT_ID}/archive.tar.gz`,
      sizeBytes: 100,
      reused: false,
      stage: "snapshotting",
      batchIndex: 0,
      batchCount: 1,
      itemsProcessed: 1,
      totalItems: 1,
      durationMs: 10,
    },
  };
}

function fakeFilesRepository() {
  return { insertBatch: vi.fn(async () => undefined) };
}

function fakeSnapshotsService() {
  return { recordManifest: vi.fn(async () => undefined) };
}

function fakeCodeSymbolsRepository() {
  return { deleteBySnapshot: vi.fn(async () => undefined), insertBatch: vi.fn(async () => undefined) };
}

function fakeFileDependenciesRepository() {
  return { deleteBySnapshot: vi.fn(async () => undefined), insertBatch: vi.fn(async () => undefined) };
}

/** A real (in-process, synchronous) AST parser behind the same interface `ParserWorkerPool` implements — exercises the real extraction/resolution logic without spinning up worker threads. */
function realFakePool(): AstParserPool {
  return {
    async parse(task: ParseTask): Promise<ParseOutcome> {
      const parser = LANGUAGE_PARSERS.get(task.language);
      if (!parser) return { relativePath: task.relativePath, result: null, error: `no parser for "${task.language}"` };
      try {
        return { relativePath: task.relativePath, result: parser.parse(task.relativePath, task.content), error: null };
      } catch (err) {
        return { relativePath: task.relativePath, result: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async destroy(): Promise<void> {},
  };
}

const config = {
  TEMP_WORK_DIR: join(tmpdir(), "aca-parser-test"),
  MAX_FILE_SIZE_KB: 512,
  MAX_EXTRACTED_SIZE_MB: 2048,
  MAX_FILES_PER_REPO: 20000,
  MAX_DIRECTORY_DEPTH: 32,
  S3_BUCKET: "aca-snapshots",
  PARSER_BATCH_SIZE: 500,
} as IndexerEnv;

const boss = { send: vi.fn().mockResolvedValue("job-1") } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  putObjectMock.mockClear();
  getObjectStreamMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function buildService(overrides: { pool?: AstParserPool; codeSymbols?: ReturnType<typeof fakeCodeSymbolsRepository>; fileDependencies?: ReturnType<typeof fakeFileDependenciesRepository> } = {}) {
  const files = fakeFilesRepository();
  const snapshots = fakeSnapshotsService();
  const codeSymbols = overrides.codeSymbols ?? fakeCodeSymbolsRepository();
  const fileDependencies = overrides.fileDependencies ?? fakeFileDependenciesRepository();
  const pool = overrides.pool ?? realFakePool();
  const service = new ParserService(
    boss,
    config,
    logger,
    {} as never,
    files as never,
    snapshots as never,
    pool,
    codeSymbols as never,
    fileDependencies as never
  );
  return { service, files, snapshots, codeSymbols, fileDependencies };
}

function findPublished(eventType: string) {
  return (boss as { send: ReturnType<typeof vi.fn> }).send.mock.calls.find((call: unknown[]) => call[0] === eventType);
}

describe("ParserService.handleSnapshotCreated", () => {
  it("extracts, filters, writes the manifest, inserts the inventory, and publishes repo.files.indexed", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([
        { name: "octocat-repo-abc123/src/app.ts", content: "export const x = 1;\n" },
        { name: "octocat-repo-abc123/README.md", content: "# hello\n" },
        { name: "octocat-repo-abc123/node_modules/left-pad/index.js", content: "module.exports = {}" },
        { name: "octocat-repo-abc123/.env", content: "SECRET=1" },
      ])
    );
    const { service, files, snapshots } = buildService();

    await service.handleSnapshotCreated(envelope());

    expect(files.insertBatch).toHaveBeenCalledTimes(1);
    const inserted = files.insertBatch.mock.calls[0]![0] as { path: string }[];
    expect(inserted.map((f) => f.path).sort()).toEqual(["README.md", "src/app.ts"]);

    expect(snapshots.recordManifest).toHaveBeenCalledWith(SNAPSHOT_ID, expect.objectContaining({ fileCount: 2 }));

    // manifest.json + 2 file objects
    expect(putObjectMock).toHaveBeenCalledTimes(3);

    const filesIndexed = findPublished("repo.files.indexed");
    expect(filesIndexed).toBeTruthy();
    expect((filesIndexed![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      fileCount: 2,
      skippedCount: 2,
      skippedReasons: expect.objectContaining({ ignored: 1, excluded_secret: 1 }),
      languages: { typescript: 1, markdown: 1 },
    });
  });

  it("extracts a symbol from the only TS/JS file and reports zero dependency edges", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/app.ts", content: "export const x = 1;\n" }]));
    const { service, codeSymbols, fileDependencies } = buildService();

    await service.handleSnapshotCreated(envelope());

    expect(codeSymbols.deleteBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(codeSymbols.insertBatch).toHaveBeenCalledTimes(1);
    const symbolRows = codeSymbols.insertBatch.mock.calls[0]![0] as { name: string; symbolType: string }[];
    expect(symbolRows).toEqual([expect.objectContaining({ name: "x", symbolType: "variable" })]);

    expect(fileDependencies.deleteBySnapshot).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(fileDependencies.insertBatch).not.toHaveBeenCalled();

    const symbolsExtracted = findPublished("repo.symbols.extracted");
    expect((symbolsExtracted![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      symbolCount: 1,
      languageSupported: true,
      byType: expect.objectContaining({ variable: 1, class: 0 }),
      stage: "parsing",
      batchIndex: 0,
      batchCount: 1,
    });

    const dependenciesExtracted = findPublished("repo.dependencies.extracted");
    expect((dependenciesExtracted![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      edgeCount: 0,
      languageSupported: true,
      byResolution: expect.objectContaining({ resolved: 0, external: 0, unresolved: 0, dynamic_unresolvable: 0 }),
    });
  });

  it("persists class heritage into code_symbols.metadata for the graph module to resolve", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([{ name: "repo/widget.ts", content: "export class Widget extends Base implements Renderable {}\n" }])
    );
    const { service, codeSymbols } = buildService();

    await service.handleSnapshotCreated(envelope());

    const symbolRows = codeSymbols.insertBatch.mock.calls[0]![0] as { name: string; metadata: Record<string, unknown> }[];
    expect(symbolRows).toEqual([
      expect.objectContaining({ name: "Widget", metadata: { extends: ["Base"], implements: ["Renderable"] } }),
    ]);
  });

  it("resolves a relative import to the real target file and records the edge", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([
        { name: "repo/src/app.ts", content: "import { helper } from './utils';\nexport const x = helper();\n" },
        { name: "repo/src/utils.ts", content: "export function helper() { return 1; }\n" },
      ])
    );
    const { service, files, fileDependencies } = buildService();

    await service.handleSnapshotCreated(envelope());

    const insertedFiles = files.insertBatch.mock.calls[0]![0] as { id: string; path: string }[];
    const utilsFileId = insertedFiles.find((f) => f.path === "src/utils.ts")!.id;

    expect(fileDependencies.insertBatch).toHaveBeenCalledTimes(1);
    const depRows = fileDependencies.insertBatch.mock.calls[0]![0] as Record<string, unknown>[];
    expect(depRows).toEqual([
      expect.objectContaining({
        rawSpecifier: "./utils",
        importKind: "esm",
        resolutionStatus: "resolved",
        targetPath: "src/utils.ts",
        targetFileId: utilsFileId,
      }),
    ]);

    const dependenciesExtracted = findPublished("repo.dependencies.extracted");
    expect((dependenciesExtracted![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      edgeCount: 1,
      byResolution: expect.objectContaining({ resolved: 1 }),
    });
  });

  it("records a non-literal dynamic import as dynamic_unresolvable without attempting resolution", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([{ name: "repo/app.ts", content: "export async function load(p: string) {\n  return import(p);\n}\n" }])
    );
    const { service, fileDependencies } = buildService();

    await service.handleSnapshotCreated(envelope());

    const depRows = fileDependencies.insertBatch.mock.calls[0]![0] as Record<string, unknown>[];
    expect(depRows).toEqual([
      expect.objectContaining({ importKind: "dynamic", resolutionStatus: "dynamic_unresolvable", targetFileId: null, targetPath: null }),
    ]);
  });

  it("skips a file that fails to parse without failing the whole stage", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([
        { name: "repo/good.ts", content: "export const ok = 1;\n" },
        { name: "repo/bad.ts", content: "export const broken = 1;\n" },
      ])
    );
    const pool: AstParserPool = {
      async parse(task) {
        if (task.relativePath === "bad.ts") return { relativePath: task.relativePath, result: null, error: "simulated timeout" };
        const parser = LANGUAGE_PARSERS.get(task.language)!;
        return { relativePath: task.relativePath, result: parser.parse(task.relativePath, task.content), error: null };
      },
      async destroy() {},
    };
    const { service, codeSymbols } = buildService({ pool });

    await service.handleSnapshotCreated(envelope());

    const symbolRows = codeSymbols.insertBatch.mock.calls[0]![0] as { name: string }[];
    expect(symbolRows).toEqual([expect.objectContaining({ name: "ok" })]);
    expect(findPublished("repo.stage.failed")).toBeUndefined();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it("reports languageSupported: false and zero counts for a non-TS/JS repository, without touching code_symbols", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/main.py", content: "print('hi')\n" }]));
    const { service, codeSymbols, fileDependencies } = buildService();

    await service.handleSnapshotCreated(envelope());

    expect(codeSymbols.deleteBySnapshot).not.toHaveBeenCalled();
    expect(codeSymbols.insertBatch).not.toHaveBeenCalled();
    expect(fileDependencies.deleteBySnapshot).not.toHaveBeenCalled();

    const symbolsExtracted = findPublished("repo.symbols.extracted");
    expect((symbolsExtracted![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      symbolCount: 0,
      languageSupported: false,
      byType: expect.objectContaining({ class: 0, variable: 0 }),
    });
    const dependenciesExtracted = findPublished("repo.dependencies.extracted");
    expect((dependenciesExtracted![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      edgeCount: 0,
      languageSupported: false,
    });
  });

  it("is idempotent across a retried snapshot: deletes previous symbols/dependencies before reinserting", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/app.ts", content: "export const x = 1;\n" }]));
    const { service, codeSymbols } = buildService();

    await service.handleSnapshotCreated(envelope());
    await service.handleSnapshotCreated(envelope());

    expect(codeSymbols.deleteBySnapshot).toHaveBeenCalledTimes(2);
    expect(codeSymbols.insertBatch).toHaveBeenCalledTimes(2);
    const firstDeleteOrder = codeSymbols.deleteBySnapshot.mock.invocationCallOrder[1]!;
    const secondInsertOrder = codeSymbols.insertBatch.mock.invocationCallOrder[1]!;
    expect(firstDeleteOrder).toBeLessThan(secondInsertOrder);
  });

  it("reports stage: \"parsing\" (not \"extracting\") when the parsing phase itself fails", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/app.ts", content: "export const x = 1;\n" }]));
    const codeSymbols = fakeCodeSymbolsRepository();
    codeSymbols.insertBatch.mockRejectedValueOnce(new Error("db exploded"));
    const { service } = buildService({ codeSymbols });

    await service.handleSnapshotCreated(envelope());

    const failure = findPublished("repo.stage.failed");
    expect((failure![1] as { payload: Record<string, unknown> }).payload).toMatchObject({ stage: "parsing" });
  });

  it("skips a binary file", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([
        { name: "repo/app.ts", content: "export const x = 1;\n" },
        { name: "repo/image.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]).toString("binary") },
      ])
    );
    const { service, files } = buildService();

    await service.handleSnapshotCreated(envelope());

    const inserted = files.insertBatch.mock.calls[0]![0] as { path: string }[];
    expect(inserted.map((f) => f.path)).toEqual(["app.ts"]);
  });

  it("skips a generated file", async () => {
    getObjectStreamMock.mockImplementation(() =>
      buildTarGz([
        { name: "repo/app.ts", content: "export const x = 1;\n" },
        { name: "repo/gen.ts", content: "// Code generated by protoc-gen-go. DO NOT EDIT.\nexport {};\n" },
      ])
    );
    const { service, files } = buildService();

    await service.handleSnapshotCreated(envelope());

    const inserted = files.insertBatch.mock.calls[0]![0] as { path: string }[];
    expect(inserted.map((f) => f.path)).toEqual(["app.ts"]);
  });

  it("still produces an inventory for a non-TypeScript repository", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/main.py", content: "print('hi')\n" }]));
    const { service, files } = buildService();

    await service.handleSnapshotCreated(envelope());

    const inserted = files.insertBatch.mock.calls[0]![0] as { path: string; language: string | null }[];
    expect(inserted).toEqual([expect.objectContaining({ path: "main.py", language: "python" })]);
  });

  it("fails the stage instead of throwing when nothing survives filtering", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/.env", content: "SECRET=1" }]));
    const { service, files } = buildService();

    await expect(service.handleSnapshotCreated(envelope())).resolves.toBeUndefined();

    expect(files.insertBatch).not.toHaveBeenCalled();
    const failurePublish = findPublished("repo.stage.failed");
    expect(failurePublish?.[1]).toMatchObject({ payload: expect.objectContaining({ errorCode: "REPO_EMPTY", stage: "extracting" }) });
  });

  it("rejects a malicious archive (path traversal) as a stage failure, not a crash", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "../../etc/passwd", content: "root:x:0:0" }]));
    const { service } = buildService();

    await expect(service.handleSnapshotCreated(envelope())).resolves.toBeUndefined();

    const failurePublish = findPublished("repo.stage.failed");
    expect(failurePublish?.[1]).toMatchObject({
      payload: expect.objectContaining({ errorCode: "ARCHIVE_UNSAFE", retryable: false, stage: "extracting" }),
    });
  });

  it("cleans up its temp directory after success", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "repo/app.ts", content: "export const x = 1;\n" }]));
    const { service } = buildService();

    const before = existsSync(config.TEMP_WORK_DIR) ? await readdir(config.TEMP_WORK_DIR) : [];
    await service.handleSnapshotCreated(envelope());
    const after = existsSync(config.TEMP_WORK_DIR) ? await readdir(config.TEMP_WORK_DIR) : [];

    expect(after).toEqual(before);
  });

  it("cleans up its temp directory even when extraction fails", async () => {
    getObjectStreamMock.mockImplementation(() => buildTarGz([{ name: "/etc/passwd", content: "x" }]));
    const { service } = buildService();

    const before = existsSync(config.TEMP_WORK_DIR) ? await readdir(config.TEMP_WORK_DIR) : [];
    await service.handleSnapshotCreated(envelope());
    const after = existsSync(config.TEMP_WORK_DIR) ? await readdir(config.TEMP_WORK_DIR) : [];

    expect(after).toEqual(before);
  });
});
