import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type Redis from "ioredis";
import { checkPoolHealth } from "@aca/db";
import { PG_POOL, REDIS_CLIENT } from "../infra.module";

export interface DependencyStatus {
  status: "ok" | "error";
  error?: string;
}

export interface ReadyResult {
  status: "ok" | "error";
  dependencies: Record<string, DependencyStatus>;
}

/** /health/ready checks the real dependencies (RULES.md #15: "not just return 200"). */
@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async checkReady(): Promise<ReadyResult> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const dependencies = { database, redis };
    const status = Object.values(dependencies).every((d) => d.status === "ok") ? "ok" : "error";
    return { status, dependencies };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    return (await checkPoolHealth(this.pool)) ? { status: "ok" } : { status: "error", error: "unreachable" };
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      await this.redis.ping();
      return { status: "ok" };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : "unreachable" };
    }
  }
}
