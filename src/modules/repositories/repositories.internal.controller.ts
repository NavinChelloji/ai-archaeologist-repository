import { Body, Controller, Get, Param, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import {
  InternalImportRepositoryRequestSchema,
  InternalRepositoriesListQuerySchema,
  InternalRepositoryOwnershipQuerySchema,
  type InternalImportRepositoryRequest,
  type InternalImportRepositoryResponse,
  type InternalRepositoriesListQuery,
  type InternalRepositoryOwnershipQuery,
  type InternalRepositoryOwnershipResponse,
  type RepositoriesListResponse,
  type RepositoryDto,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { RepositoriesService } from "./repositories.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (GITHUB_CONNECTOR_SERVICE_PLAN.md "APIs").
 */
@Controller("internal/repositories")
@UseGuards(InternalAuthGuard)
export class RepositoriesInternalController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Post("import")
  @UsePipes(new ZodValidationPipe(InternalImportRepositoryRequestSchema))
  async import(@Body() body: InternalImportRepositoryRequest): Promise<InternalImportRepositoryResponse> {
    const result = await this.repositories.import(body);
    return { ...result.repository, created: result.created };
  }

  @Get()
  @UsePipes(new ZodValidationPipe(InternalRepositoriesListQuerySchema))
  async list(@Query() query: InternalRepositoriesListQuery): Promise<RepositoriesListResponse> {
    return this.repositories.listByOwner(query.ownerUserId, query.pageSize, query.cursor);
  }

  @Get(":repoId")
  async getById(@Param("repoId") repoId: string): Promise<RepositoryDto> {
    return this.repositories.getById(repoId);
  }

  @Get(":repoId/ownership")
  async ownership(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(InternalRepositoryOwnershipQuerySchema)) query: InternalRepositoryOwnershipQuery
  ): Promise<InternalRepositoryOwnershipResponse> {
    const owns = await this.repositories.isOwnedBy(repoId, query.userId);
    return { owns };
  }
}
