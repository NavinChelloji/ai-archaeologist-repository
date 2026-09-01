import { describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { DeletionService } from "./deletion.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const config = { S3_BUCKET: "aca-snapshots" } as unknown as IndexerEnv;

vi.mock("@aca/storage", async () => {
  const actual = await vi.importActual<typeof import("@aca/storage")>("@aca/storage");
  return { ...actual, deleteObjectsByPrefix: vi.fn().mockResolvedValue(2) };
});

describe("DeletionService", () => {
  it("soft-deletes, hard-deletes, and removes the repository's S3 prefix", async () => {
    const softDelete = vi.fn().mockResolvedValue(undefined);
    const hardDelete = vi.fn().mockResolvedValue(undefined);
    const repositories = { softDelete, hardDelete, listAllIdsByOwner: vi.fn() } as never;
    const s3 = {} as never;

    const deletion = new DeletionService(config, noopLogger, s3, repositories);
    await deletion.deleteRepository("repo-1");

    expect(softDelete).toHaveBeenCalledWith("repo-1");
    expect(hardDelete).toHaveBeenCalledWith("repo-1");
  });

  it("is idempotent — a second call against an already-gone repo does not throw", async () => {
    const repositories = {
      softDelete: vi.fn().mockResolvedValue(undefined),
      hardDelete: vi.fn().mockResolvedValue(undefined),
      listAllIdsByOwner: vi.fn(),
    } as never;
    const s3 = {} as never;

    const deletion = new DeletionService(config, noopLogger, s3, repositories);
    await deletion.deleteRepository("repo-1");
    await expect(deletion.deleteRepository("repo-1")).resolves.toBeUndefined();
  });

  it("deletes every repo the event names plus any straggler still owned by the user", async () => {
    const deleteRepository = vi.fn().mockResolvedValue(undefined);
    const repositories = {
      softDelete: deleteRepository,
      hardDelete: deleteRepository,
      listAllIdsByOwner: vi.fn().mockResolvedValue(["repo-3"]),
    } as never;
    const s3 = {} as never;

    const deletion = new DeletionService(config, noopLogger, s3, repositories);
    const deleteRepositorySpy = vi.spyOn(deletion, "deleteRepository");
    await deletion.deleteForUser("user-1", ["repo-1", "repo-2"]);

    expect(deleteRepositorySpy).toHaveBeenCalledTimes(3);
    expect(deleteRepositorySpy.mock.calls.flat().sort()).toEqual(["repo-1", "repo-2", "repo-3"]);
  });

  it("does not delete a straggler twice when it also appears in the event's repoIds", async () => {
    const repositories = {
      softDelete: vi.fn().mockResolvedValue(undefined),
      hardDelete: vi.fn().mockResolvedValue(undefined),
      listAllIdsByOwner: vi.fn().mockResolvedValue(["repo-1"]),
    } as never;
    const s3 = {} as never;

    const deletion = new DeletionService(config, noopLogger, s3, repositories);
    const deleteRepositorySpy = vi.spyOn(deletion, "deleteRepository");
    await deletion.deleteForUser("user-1", ["repo-1"]);

    expect(deleteRepositorySpy).toHaveBeenCalledTimes(1);
  });
});
