import type { Pool } from "pg";
import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

function fakePool(healthy: boolean): Pool {
  return {
    query: vi.fn().mockImplementation(async () => {
      if (!healthy) throw new Error("connection refused");
      return { rows: [{ "?column?": 1 }] };
    }),
  } as unknown as Pool;
}

function fakeRedis(healthy: boolean): Redis {
  return {
    ping: vi.fn().mockImplementation(async () => {
      if (!healthy) throw new Error("connection refused");
      return "PONG";
    }),
  } as unknown as Redis;
}

describe("HealthService.checkReady", () => {
  it("reports ok when every dependency is reachable", async () => {
    const health = new HealthService(fakePool(true), fakeRedis(true));
    const result = await health.checkReady();
    expect(result.status).toBe("ok");
    expect(result.dependencies.database.status).toBe("ok");
    expect(result.dependencies.redis.status).toBe("ok");
  });

  it("reports error and names the failing dependency", async () => {
    const health = new HealthService(fakePool(false), fakeRedis(true));
    const result = await health.checkReady();
    expect(result.status).toBe("error");
    expect(result.dependencies.database.status).toBe("error");
    expect(result.dependencies.redis.status).toBe("ok");
  });
});
