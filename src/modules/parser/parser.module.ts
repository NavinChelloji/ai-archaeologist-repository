import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, ConfigModule } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { InternalModule } from "../../internal/internal.module";
import { RepositoriesModule } from "../repositories/repositories.module";
import { ParserWorkerPool, PARSER_WORKER_POOL, type AstParserPool } from "./ast-workers/worker-pool";
import { CodeSymbolsRepository } from "./code-symbols.repository";
import { FileDependenciesRepository } from "./file-dependencies.repository";
import { ParserInternalController } from "./parser.internal.controller";
import { ParserReadService } from "./parser-read.service";
import { ParserService } from "./parser.service";
import { RepositoryFilesRepository } from "./repository-files.repository";
import { ParserWorkersService } from "./workers/parser-workers.service";

@Module({
  imports: [ConfigModule, InternalModule, RepositoriesModule],
  controllers: [ParserInternalController],
  exports: [ParserReadService],
  providers: [
    ParserService,
    ParserReadService,
    RepositoryFilesRepository,
    CodeSymbolsRepository,
    FileDependenciesRepository,
    ParserWorkersService,
    {
      provide: PARSER_WORKER_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: IndexerEnv) => new ParserWorkerPool(config.PARSER_CONCURRENCY, config.PARSER_FILE_TIMEOUT_MS),
    },
  ],
})
export class ParserModule implements OnModuleDestroy {
  constructor(@Inject(PARSER_WORKER_POOL) private readonly pool: AstParserPool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }
}
