import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  GraphDependenciesQuerySchema,
  GraphFoldersQuerySchema,
  GraphNeighborsQuerySchema,
  GraphSearchQuerySchema,
  GraphSymbolsQuerySchema,
  TreeQuerySchema,
  type GraphDependenciesQuery,
  type GraphFoldersQuery,
  type GraphNeighborsQuery,
  type GraphResponse,
  type GraphSearchQuery,
  type GraphSearchResponse,
  type GraphSymbolsQuery,
  type TreeQuery,
  type TreeResponse,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { GraphReadService } from "./graph-read.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (GRAPH_SERVICE_PLAN.md "APIs").
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class GraphInternalController {
  constructor(private readonly graphRead: GraphReadService) {}

  @Get("repositories/:repoId/tree")
  async getTree(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(TreeQuerySchema)) query: TreeQuery
  ): Promise<TreeResponse> {
    return this.graphRead.getTree(repoId, query);
  }

  @Get("repositories/:repoId/graph/folders")
  async getFolders(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(GraphFoldersQuerySchema)) query: GraphFoldersQuery
  ): Promise<GraphResponse> {
    return this.graphRead.getFolders(repoId, query);
  }

  @Get("repositories/:repoId/graph/dependencies")
  async getDependencies(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(GraphDependenciesQuerySchema)) query: GraphDependenciesQuery
  ): Promise<GraphResponse> {
    return this.graphRead.getDependencies(repoId, query);
  }

  @Get("repositories/:repoId/graph/symbols")
  async getSymbols(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(GraphSymbolsQuerySchema)) query: GraphSymbolsQuery
  ): Promise<GraphResponse> {
    return this.graphRead.getSymbols(repoId, query);
  }

  @Get("repositories/:repoId/graph/nodes/:nodeId/neighbors")
  async getNeighbors(
    @Param("repoId") repoId: string,
    @Param("nodeId") nodeId: string,
    @Query(new ZodValidationPipe(GraphNeighborsQuerySchema)) query: GraphNeighborsQuery
  ): Promise<GraphResponse> {
    return this.graphRead.getNeighbors(repoId, nodeId, query);
  }

  @Get("repositories/:repoId/graph/search")
  async search(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(GraphSearchQuerySchema)) query: GraphSearchQuery
  ): Promise<GraphSearchResponse> {
    return this.graphRead.search(repoId, query);
  }
}
