import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { ParserModule } from "../parser/parser.module";
import { RepositoriesModule } from "../repositories/repositories.module";
import { GraphBuildStateRepository } from "./graph-build-state.repository";
import { GraphBuilderService } from "./graph-builder.service";
import { GraphEdgesRepository } from "./graph-edges.repository";
import { GraphNodesRepository } from "./graph-nodes.repository";
import { GraphReadService } from "./graph-read.service";
import { GraphInternalController } from "./graph.internal.controller";
import { GraphWorkersService } from "./workers/graph-workers.service";

@Module({
  imports: [ConfigModule, InternalModule, RepositoriesModule, ParserModule],
  controllers: [GraphInternalController],
  providers: [
    GraphBuildStateRepository,
    GraphNodesRepository,
    GraphEdgesRepository,
    GraphBuilderService,
    GraphReadService,
    GraphWorkersService,
  ],
})
export class GraphModule {}
