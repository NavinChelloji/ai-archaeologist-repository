import { Global, Inject, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import Redis from "ioredis";
import { createPool } from "@aca/db";
import { attachErrorLogging, createBoss, startBoss, stopBoss } from "@aca/queue";
import { createLogger } from "@aca/logger";
import { createS3Client } from "@aca/storage";
import { ConfigModule, APP_CONFIG } from "../config/config.module";
import type { IndexerEnv } from "../config/env";

export const PG_POOL = Symbol("PG_POOL");
export const REDIS_CLIENT = Symbol("REDIS_CLIENT");
export const PG_BOSS = Symbol("PG_BOSS");
export const APP_LOGGER = Symbol("APP_LOGGER");
export const S3_CLIENT = Symbol("S3_CLIENT");

/**
 * Wires the three infra dependencies every deployable needs — its own
 * Postgres pool, Redis, and a pg-boss connection to the shared aca_queue
 * database — as global providers, closed together on shutdown
 * (RULES.md #4 "graceful shutdown: ... close pools").
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: APP_LOGGER, useFactory: () => createLogger({ service: "indexer" }) },
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: IndexerEnv) => createPool(config.INDEXER_DATABASE_URL),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: IndexerEnv) => new Redis(config.REDIS_URL, { lazyConnect: false }),
    },
    {
      provide: PG_BOSS,
      inject: [APP_CONFIG, APP_LOGGER],
      useFactory: (config: IndexerEnv, logger: ReturnType<typeof createLogger>) => {
        const boss = createBoss(config.QUEUE_DATABASE_URL);
        attachErrorLogging(boss, logger);
        return boss;
      },
    },
    {
      provide: S3_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: IndexerEnv) =>
        createS3Client({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
        }),
    },
  ],
  exports: [PG_POOL, REDIS_CLIENT, PG_BOSS, APP_LOGGER, S3_CLIENT],
})
export class InfraModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async onModuleInit(): Promise<void> {
    await startBoss(this.boss);
  }

  async onModuleDestroy(): Promise<void> {
    await stopBoss(this.boss);
    await this.pool.end();
    this.redis.disconnect();
  }
}
