import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import type { RepositoryRow } from "./repositories.repository";
import { SnapshotDownloadService } from "./snapshot-download.service";
import type { SnapshotRow } from "./snapshots.repository";

const putObjectMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@aca/storage", async () => {
  const actual = await vi.importActual<typeof import("@aca/storage")>("@aca/storage");
  return { ...actual, putObject: putObjectMock };
});

const REPO_ID = "123e4567-e89b-12d3-a456-426614174000";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const CORRELATION_ID = "123e4567-e89b-12d3-a456-426614174002";
const EVENT_ID = "123e4567-e89b-12d3-a456-426614174003";

function envelope(overrides: Partial<TypedEnvelope<"repo.import.requested">["payload"]> = {}): TypedEnvelope<"repo.import.requested"> {
  return {
    eventId: EVENT_ID,
    eventType: "repo.import.requested",
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: CORRELATION_ID,
    causationId: null,
    userId: USER_ID,
    repoId: REPO_ID,
    snapshotId: null,
    retryCount: 0,
    payload: {
      provider: "github",
      providerRepoId: "1",
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      isPrivate: false,
      ref: null,
      reindex: false,
      ...overrides,
    },
  };
}

function repositoryRow(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    id: REPO_ID,
    owner_user_id: USER_ID,
    provider: "github",
    provider_repo_id: "1",
    full_name: "octocat/hello-world",
    default_branch: "main",
    is_private: false,
    primary_language: "TypeScript",
    active_snapshot_id: null,
    metadata: {},
    deleted_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function snapshotRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: "123e4567-e89b-12d3-a456-426614174010",
    repo_id: REPO_ID,
    commit_sha: "abc123",
    ref: "main",
    archive_key: null,
    manifest_key: null,
    size_bytes: null,
    file_count: null,
    status: "pending",
    error_code: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepositoriesRepository(row: RepositoryRow | null) {
  return { findById: vi.fn(async () => row) };
}

function fakeSnapshotsRepository(existing: SnapshotRow | null = null) {
  const stored = { ...(existing ?? {}) } as Partial<SnapshotRow>;
  return {
    findByRepoAndSha: vi.fn(async () => existing),
    createPending: vi.fn(async (input: { id: string; repoId: string; commitSha: string; ref: string }) => {
      const row = snapshotRow({ id: input.id, repo_id: input.repoId, commit_sha: input.commitSha, ref: input.ref });
      Object.assign(stored, row);
      return row;
    }),
    markDownloading: vi.fn(async () => undefined),
    markStored: vi.fn(async (id: string, input: { archiveKey: string; sizeBytes: number }) =>
      snapshotRow({ id, archive_key: input.archiveKey, size_bytes: String(input.sizeBytes), status: "stored" })
    ),
    markFailed: vi.fn(async () => undefined),
  };
}

function fakeTokenClient() {
  return { fetchToken: vi.fn(async () => "gh-token") };
}

function fakeTarballClient(headSha = "abc123") {
  return {
    resolveHeadSha: vi.fn(async () => headSha),
    downloadTarball: vi.fn(async (input: { destPath: string }) => {
      await writeFile(input.destPath, "fake-tarball-bytes");
      return { sizeBytes: 19 };
    }),
  };
}

const config = {
  TEMP_WORK_DIR: join(tmpdir(), "aca-snapshot-test"),
  MAX_REPOSITORY_ARCHIVE_MB: 500,
  S3_BUCKET: "aca-snapshots",
} as IndexerEnv;

const boss = { send: vi.fn().mockResolvedValue("job-1") } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  putObjectMock.mockClear();
});

afterEach(async () => {
  vi.clearAllMocks();
});

describe("SnapshotDownloadService.handleImportRequested", () => {
  it("downloads the tarball, uploads it to S3, and publishes repo.snapshot.created", async () => {
    const repositories = fakeRepositoriesRepository(repositoryRow());
    const snapshots = fakeSnapshotsRepository(null);
    const tarball = fakeTarballClient();
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      tarball as never
    );

    await service.handleImportRequested(envelope());

    expect(snapshots.createPending).toHaveBeenCalledTimes(1);
    expect(snapshots.markDownloading).toHaveBeenCalledTimes(1);
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    expect(snapshots.markStored).toHaveBeenCalledTimes(1);
    expect((boss as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
      "repo.snapshot.created",
      expect.objectContaining({ eventType: "repo.snapshot.created" }),
      {}
    );
  });

  it("reuses an existing stored snapshot for the same commit SHA without downloading again", async () => {
    const repositories = fakeRepositoriesRepository(repositoryRow());
    const existing = snapshotRow({ status: "stored", archive_key: "repo/snap/archive.tar.gz", size_bytes: "42" });
    const snapshots = fakeSnapshotsRepository(existing);
    const tarball = fakeTarballClient();
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      tarball as never
    );

    await service.handleImportRequested(envelope());

    expect(tarball.downloadTarball).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(snapshots.createPending).not.toHaveBeenCalled();
    const [, publishedEnvelope] = (boss as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]!;
    expect(publishedEnvelope.payload.reused).toBe(true);
  });

  it("cleans up its temp directory after a successful download", async () => {
    const repositories = fakeRepositoriesRepository(repositoryRow());
    const snapshots = fakeSnapshotsRepository(null);
    let capturedTempDir = "";
    const tarball = {
      resolveHeadSha: vi.fn(async () => "abc123"),
      downloadTarball: vi.fn(async (input: { destPath: string }) => {
        capturedTempDir = join(input.destPath, "..");
        await writeFile(input.destPath, "fake-tarball-bytes");
        return { sizeBytes: 19 };
      }),
    };
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      tarball as never
    );

    await service.handleImportRequested(envelope());

    expect(capturedTempDir).not.toBe("");
    expect(existsSync(capturedTempDir)).toBe(false);
  });

  it("cleans up its temp directory even when the upload fails", async () => {
    putObjectMock.mockRejectedValueOnce(new Error("s3 unreachable"));
    const repositories = fakeRepositoriesRepository(repositoryRow());
    const snapshots = fakeSnapshotsRepository(null);
    let capturedTempDir = "";
    const tarball = {
      resolveHeadSha: vi.fn(async () => "abc123"),
      downloadTarball: vi.fn(async (input: { destPath: string }) => {
        capturedTempDir = join(input.destPath, "..");
        await writeFile(input.destPath, "fake-tarball-bytes");
        return { sizeBytes: 19 };
      }),
    };
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      tarball as never
    );

    await service.handleImportRequested(envelope());

    expect(capturedTempDir).not.toBe("");
    expect(existsSync(capturedTempDir)).toBe(false);
    expect(snapshots.markFailed).not.toHaveBeenCalled();
    const failurePublish = (boss as { send: ReturnType<typeof vi.fn> }).send.mock.calls.find(
      (call: unknown[]) => call[0] === "repo.stage.failed"
    );
    expect(failurePublish).toBeTruthy();
  });

  it("publishes repo.stage.failed instead of throwing when the archive is oversized", async () => {
    const repositories = fakeRepositoriesRepository(repositoryRow());
    const snapshots = fakeSnapshotsRepository(null);
    const tarball = {
      resolveHeadSha: vi.fn(async () => "abc123"),
      downloadTarball: vi.fn(async () => {
        const { AppError } = await import("@aca/contracts");
        throw new AppError("REPO_TOO_LARGE", "too big");
      }),
    };
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      tarball as never
    );

    await expect(service.handleImportRequested(envelope())).resolves.toBeUndefined();

    const failurePublish = (boss as { send: ReturnType<typeof vi.fn> }).send.mock.calls.find(
      (call: unknown[]) => call[0] === "repo.stage.failed"
    );
    expect(failurePublish?.[1]).toMatchObject({ payload: expect.objectContaining({ errorCode: "REPO_TOO_LARGE", retryable: false }) });
  });

  it("skips silently when the repository no longer exists", async () => {
    const repositories = fakeRepositoriesRepository(null);
    const snapshots = fakeSnapshotsRepository(null);
    const service = new SnapshotDownloadService(
      boss,
      config,
      logger,
      {} as never,
      repositories as never,
      snapshots as never,
      fakeTokenClient() as never,
      fakeTarballClient() as never
    );

    await expect(service.handleImportRequested(envelope())).resolves.toBeUndefined();
    expect(snapshots.createPending).not.toHaveBeenCalled();
  });
});
