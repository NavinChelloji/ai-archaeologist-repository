import { describe, expect, it, vi } from "vitest";
import type { IndexerEnv } from "../../config/env";
import { QueueMetricsSweeperService } from "./queue-metrics-sweeper.service";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const config = { QUEUE_METRICS_SWEEP_SECONDS: 30 } as unknown as IndexerEnv;

function fakeMetrics() {
  return {
    queueDepth: { set: vi.fn() },
    dlqDepth: { set: vi.fn() },
    oldestJobAgeSeconds: { set: vi.fn() },
  };
}

describe("QueueMetricsSweeperService", () => {
  it("sets queue depth and dlq depth gauges for every known queue", async () => {
    const boss = { getQueueSize: vi.fn(async (name: string) => (name.endsWith(".dlq") ? 0 : 3)) };
    const metrics = fakeMetrics();
    const jobs = { findOldestActive: vi.fn().mockResolvedValue(null) };

    const sweeper = new QueueMetricsSweeperService(boss as never, metrics as never, config, noopLogger, jobs as never);
    await sweeper.sweep();

    expect(metrics.queueDepth.set).toHaveBeenCalledWith({ queue: "repo.deleted" }, 3);
    expect(metrics.dlqDepth.set).toHaveBeenCalledWith({ queue: "repo.deleted" }, 0);
  });

  it("sets the oldest job age to 0 when nothing is in flight", async () => {
    const boss = { getQueueSize: vi.fn().mockResolvedValue(0) };
    const metrics = fakeMetrics();
    const jobs = { findOldestActive: vi.fn().mockResolvedValue(null) };

    const sweeper = new QueueMetricsSweeperService(boss as never, metrics as never, config, noopLogger, jobs as never);
    await sweeper.sweep();

    expect(metrics.oldestJobAgeSeconds.set).toHaveBeenCalledWith({ status: "active" }, 0);
  });

  it("reports a positive age in seconds for an in-flight job", async () => {
    const boss = { getQueueSize: vi.fn().mockResolvedValue(0) };
    const metrics = fakeMetrics();
    const jobs = { findOldestActive: vi.fn().mockResolvedValue({ created_at: new Date(Date.now() - 5000) }) };

    const sweeper = new QueueMetricsSweeperService(boss as never, metrics as never, config, noopLogger, jobs as never);
    await sweeper.sweep();

    const [, age] = metrics.oldestJobAgeSeconds.set.mock.calls[0]!;
    expect(age).toBeGreaterThanOrEqual(5);
  });
});
