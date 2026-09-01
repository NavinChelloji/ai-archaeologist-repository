import { describe, expect, it, vi } from "vitest";
import type { TypedEnvelope } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { SnapshotPruneService } from "./snapshot-prune.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const config = { S3_BUCKET: "aca-snapshots" } as unknown as IndexerEnv;

vi.mock("@aca/storage", async () => {
  const actual = await vi.importActual<typeof import("@aca/storage")>("@aca/storage");
  return { ...actual, deleteObjectsByPrefix: vi.fn().mockResolvedValue(3) };
});

function envelope(repoId: string, retainCount: number): TypedEnvelope<"snapshot.prune"> {
  return {
    eventId: "11111111-1111-1111-1111-111111111111",
    eventType: "snapshot.prune",
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: "22222222-2222-2222-2222-222222222222",
    causationId: null,
    userId: "00000000-0000-0000-0000-000000000000",
    repoId,
    snapshotId: null,
    retryCount: 0,
    payload: { repoId, retainCount },
  };
}

describe("SnapshotPruneService", () => {
  it("keeps the active snapshot plus the most recent retainCount, deleting the rest", async () => {
    const snaps = [
      { id: "s-4", created_at: new Date("2026-01-04") },
      { id: "s-3", created_at: new Date("2026-01-03") },
      { id: "s-2", created_at: new Date("2026-01-02") },
      { id: "s-1", created_at: new Date("2026-01-01") }, // active, but oldest
    ];
    const repositories = { findById: vi.fn().mockResolvedValue({ active_snapshot_id: "s-1" }) } as never;
    const deleteById = vi.fn().mockResolvedValue(undefined);
    const snapshots = { listByRepoOrderedDesc: vi.fn().mockResolvedValue(snaps), deleteById } as never;

    const prune = new SnapshotPruneService(config, noopLogger, {} as never, repositories, snapshots);
    await prune.handleSnapshotPrune(envelope("repo-1", 2));

    // retain: s-4, s-3 (top 2 by recency) + s-1 (active) => delete only s-2
    expect(deleteById).toHaveBeenCalledTimes(1);
    expect(deleteById).toHaveBeenCalledWith("s-2");
  });

  it("does nothing when the repo has no more than retainCount snapshots", async () => {
    const snaps = [{ id: "s-1", created_at: new Date() }];
    const repositories = { findById: vi.fn().mockResolvedValue({ active_snapshot_id: "s-1" }) } as never;
    const deleteById = vi.fn();
    const snapshots = { listByRepoOrderedDesc: vi.fn().mockResolvedValue(snaps), deleteById } as never;

    const prune = new SnapshotPruneService(config, noopLogger, {} as never, repositories, snapshots);
    await prune.handleSnapshotPrune(envelope("repo-1", 2));

    expect(deleteById).not.toHaveBeenCalled();
  });

  it("is idempotent — pruning again after everything eligible was already deleted deletes nothing more", async () => {
    const remaining = [{ id: "s-4", created_at: new Date("2026-01-04") }, { id: "s-3", created_at: new Date("2026-01-03") }];
    const repositories = { findById: vi.fn().mockResolvedValue({ active_snapshot_id: "s-4" }) } as never;
    const deleteById = vi.fn();
    const snapshots = { listByRepoOrderedDesc: vi.fn().mockResolvedValue(remaining), deleteById } as never;

    const prune = new SnapshotPruneService(config, noopLogger, {} as never, repositories, snapshots);
    await prune.handleSnapshotPrune(envelope("repo-1", 2));

    expect(deleteById).not.toHaveBeenCalled();
  });

  it("lists retained snapshot ids for ai's orphan cleanup", async () => {
    const snaps = [{ id: "s-2" }, { id: "s-1" }];
    const snapshots = { listByRepoOrderedDesc: vi.fn().mockResolvedValue(snaps) } as never;
    const prune = new SnapshotPruneService(config, noopLogger, {} as never, {} as never, snapshots);

    const ids = await prune.listRetainedSnapshotIds("repo-1");
    expect(ids).toEqual(["s-2", "s-1"]);
  });
});
