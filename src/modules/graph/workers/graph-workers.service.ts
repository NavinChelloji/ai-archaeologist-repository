import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { DEFAULT_RETRY_POLICY, ensureProductQueue, subscribeJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_LOGGER, PG_BOSS, PG_POOL } from "../../../shared/infra.module";
import { GraphBuilderService } from "../graph-builder.service";

const CONSUMER = "indexer.graph";

/** This module's own fan-out queues — see `FANOUT_QUEUES` in `@aca/queue`. Pipeline consumes the same three events on their default-named queues, separately, for job bookkeeping. */
const FILES_INDEXED_QUEUE = "repo.files.indexed.graph";
const SYMBOLS_EXTRACTED_QUEUE = "repo.symbols.extracted.graph";
const DEPENDENCIES_EXTRACTED_QUEUE = "repo.dependencies.extracted.graph";

/**
 * Registers this module's queue subscriptions (GRAPH_SERVICE_PLAN.md
 * "Jobs: Consumed"). `repo.graph.built` and `repo.stage.failed` are
 * published here but their queues are already `ensureProductQueue`'d by
 * PipelineWorkersService (which also consumes both) — no need to repeat
 * that registration. Runs in both the HTTP and `--role=worker` processes,
 * same as the other workers services.
 */
@Injectable()
export class GraphWorkersService implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly graphBuilder: GraphBuilderService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureProductQueue(this.boss, "repo.files.indexed", DEFAULT_RETRY_POLICY, FILES_INDEXED_QUEUE);
    await ensureProductQueue(this.boss, "repo.symbols.extracted", DEFAULT_RETRY_POLICY, SYMBOLS_EXTRACTED_QUEUE);
    await ensureProductQueue(this.boss, "repo.dependencies.extracted", DEFAULT_RETRY_POLICY, DEPENDENCIES_EXTRACTED_QUEUE);

    await subscribeJob(
      this.boss,
      "repo.files.indexed",
      { consumer: `${CONSUMER}.files_indexed`, pool: this.pool, logger: this.logger },
      (envelope) => this.graphBuilder.handleFilesIndexed(envelope),
      FILES_INDEXED_QUEUE
    );

    await subscribeJob(
      this.boss,
      "repo.symbols.extracted",
      { consumer: `${CONSUMER}.symbols_extracted`, pool: this.pool, logger: this.logger },
      (envelope) => this.graphBuilder.handleSymbolsExtracted(envelope),
      SYMBOLS_EXTRACTED_QUEUE
    );

    await subscribeJob(
      this.boss,
      "repo.dependencies.extracted",
      { consumer: `${CONSUMER}.dependencies_extracted`, pool: this.pool, logger: this.logger },
      (envelope) => this.graphBuilder.handleDependenciesExtracted(envelope),
      DEPENDENCIES_EXTRACTED_QUEUE
    );
  }
}
