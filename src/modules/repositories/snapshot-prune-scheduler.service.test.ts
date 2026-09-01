import { describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { SnapshotPruneSchedulerService } from "./snapshot-prune-scheduler.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const config = {
  SNAPSHOT_RETENTION_COUNT: 2,
  SNAPSHOT_PRUNE_SWEEP_SECONDS: 3600,
  SNAPSHOT_PRUNE_BATCH_SIZE: 50,
} as unknown as IndexerEnv;

describe("SnapshotPruneSchedulerService", () => {
  it("publishes snapshot.prune for every repo exceeding retention", async () => {
    const REPO_1 = "123e4567-e89b-12d3-a456-426614174000";
    const REPO_2 = "123e4567-e89b-12d3-a456-426614174001";
    const listRepoIdsExceedingRetention = vi.fn().mockResolvedValue([REPO_1, REPO_2]);
    const snapshots = { listRepoIdsExceedingRetention } as never;
    const send = vi.fn().mockResolvedValue("job-1");
    const boss = { send } as never;

    const scheduler = new SnapshotPruneSchedulerService(boss, config, noopLogger, snapshots);
    await scheduler.sweep();

    expect(listRepoIdsExceedingRetention).toHaveBeenCalledWith(2, 50);
    // snapshot.prune fans out to both indexer's and ai's queues (@aca/queue FANOUT_QUEUES) — 2 sends per repo.
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith("snapshot.prune", expect.anything(), {});
    expect(send).toHaveBeenCalledWith("snapshot.prune.ai", expect.anything(), {});
  });

  it("does nothing when no repo exceeds retention", async () => {
    const snapshots = { listRepoIdsExceedingRetention: vi.fn().mockResolvedValue([]) } as never;
    const send = vi.fn();
    const boss = { send } as never;

    const scheduler = new SnapshotPruneSchedulerService(boss, config, noopLogger, snapshots);
    await scheduler.sweep();

    expect(send).not.toHaveBeenCalled();
  });
});
