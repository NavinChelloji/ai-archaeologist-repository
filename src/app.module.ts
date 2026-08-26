import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule } from "./config/config.module";
import { InfraModule } from "./shared/infra.module";
import { HealthModule } from "./shared/health/health.module";
import { AllExceptionsFilter } from "./shared/errors/all-exceptions.filter";
import { InternalModule } from "./internal/internal.module";
import { SystemModule } from "./modules/system/system.module";
import { RepositoriesModule } from "./modules/repositories/repositories.module";
import { PipelineModule } from "./modules/pipeline/pipeline.module";
import { ParserModule } from "./modules/parser/parser.module";
import { GraphModule } from "./modules/graph/graph.module";

@Module({
  imports: [
    ConfigModule,
    InfraModule,
    HealthModule,
    InternalModule,
    SystemModule,
    RepositoriesModule,
    PipelineModule,
    ParserModule,
    GraphModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
