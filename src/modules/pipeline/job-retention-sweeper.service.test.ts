import { describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { JobRetentionSweeperService } from "./job-retention-sweeper.service";

describe("JobRetentionSweeperService", () => {
  it("deletes terminal jobs older than the retention cutoff and logs the count", async () => {
    const deleteTerminalOlderThan = vi.fn().mockResolvedValue(3);
    const jobs = { deleteTerminalOlderThan } as never;
    const config = { JOB_EVENT_RETENTION_DAYS: 30, JOB_RETENTION_SWEEP_SECONDS: 86400 } as unknown as IndexerEnv;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const sweeper = new JobRetentionSweeperService(config, logger as never, jobs);
    await sweeper.sweep();

    expect(deleteTerminalOlderThan).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ deletedCount: 3 }), expect.any(String));
  });

  it("stays quiet when nothing was old enough to delete", async () => {
    const deleteTerminalOlderThan = vi.fn().mockResolvedValue(0);
    const jobs = { deleteTerminalOlderThan } as never;
    const config = { JOB_EVENT_RETENTION_DAYS: 30, JOB_RETENTION_SWEEP_SECONDS: 86400 } as unknown as IndexerEnv;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const sweeper = new JobRetentionSweeperService(config, logger as never, jobs);
    await sweeper.sweep();

    expect(logger.info).not.toHaveBeenCalled();
  });
});
