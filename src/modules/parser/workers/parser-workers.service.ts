import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { ParserService } from "../parser.service";

const CONSUMER = "indexer.parser";

/** This module's own fan-out queue for `repo.snapshot.created` — see `FANOUT_QUEUES` in `@aca/queue`. Pipeline consumes the same event on its own, separately-named queue for job bookkeeping. */
const QUEUE_NAME = "repo.snapshot.created.parser";

/**
 * Registers this module's queue subscription
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Jobs: Consumed"). Runs in both the
 * HTTP and `--role=worker` processes, same as PipelineWorkersService.
 */
@Injectable()
export class ParserWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly parser: ParserService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.snapshot.created", DEFAULT_RETRY_POLICY, QUEUE_NAME);

    await subscribeJob(
      this.boss,
      "repo.snapshot.created",
      { consumer: `${CONSUMER}.snapshot_created`, pool: this.pool, logger: this.logger },
      (envelope) => this.parser.handleSnapshotCreated(envelope),
      QUEUE_NAME
    );
  }
}
