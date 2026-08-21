import { describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { StalledJobSweeperService } from "./stalled-job-sweeper.service";

describe("StalledJobSweeperService", () => {
  it("fails every job returned by the stalled query and leaves fresh jobs alone", async () => {
    const stalledJob = { id: "job-1", repo_id: "repo-1", current_stage: "parsing" };
    const findStalled = vi.fn().mockResolvedValue([stalledJob]);
    const jobs = { findStalled } as never;
    const failStalled = vi.fn().mockResolvedValue(undefined);
    const pipeline = { failStalled } as never;
    const config = { STAGE_TIMEOUT_SECONDS: 1800, STALLED_JOB_SWEEP_SECONDS: 60 } as unknown as IndexerEnv;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    const sweeper = new StalledJobSweeperService(config, logger, jobs, pipeline);
    await sweeper.sweep();

    expect(findStalled).toHaveBeenCalledTimes(1);
    expect(failStalled).toHaveBeenCalledWith(stalledJob);
  });

  it("does nothing when no job has stalled", async () => {
    const findStalled = vi.fn().mockResolvedValue([]);
    const jobs = { findStalled } as never;
    const failStalled = vi.fn();
    const pipeline = { failStalled } as never;
    const config = { STAGE_TIMEOUT_SECONDS: 1800, STALLED_JOB_SWEEP_SECONDS: 60 } as unknown as IndexerEnv;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    const sweeper = new StalledJobSweeperService(config, logger, jobs, pipeline);
    await sweeper.sweep();

    expect(failStalled).not.toHaveBeenCalled();
  });
});
