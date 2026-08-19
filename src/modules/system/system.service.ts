import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { ensureSystemPingQueue, subscribeSystemPing, type SystemPingPayload } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../shared/infra.module";

const CONSUMER = "indexer.system.ping";

/**
 * Stage 1 smoke test for the exit criterion "a trivial pg-boss job can be
 * enqueued in api and consumed in indexer" (DEVELOPMENT_STAGES.md Stage 1).
 * Subscribes to `system.health.ping`; a log line here confirms the queue,
 * the processed_events idempotency table, and this worker all wire up end
 * to end. See @aca/queue's systemPing module for why this job is kept out
 * of the documented product job vocabulary.
 */
@Injectable()
export class SystemService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureSystemPingQueue(this.boss);

    await subscribeSystemPing(
      this.boss,
      { consumer: CONSUMER, pool: this.pool, logger: this.logger },
      async (payload: SystemPingPayload, jobId: string) => {
        const latencyMs = Date.now() - new Date(payload.sentAt).getTime();
        this.logger.info({ jobId, pingId: payload.pingId, latencyMs }, "received ping");
      }
    );
  }
}
