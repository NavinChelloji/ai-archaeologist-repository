import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import {
  InternalImportRepositoryRequestSchema,
  InternalRepositoriesListQuerySchema,
  InternalRepositoryOwnershipQuerySchema,
  type InternalImportRepositoryRequest,
  type InternalImportRepositoryResponse,
  type InternalRepositoriesListQuery,
  type InternalRepositoryOwnershipQuery,
  type InternalRepositoryOwnershipResponse,
  type InternalRepositorySnapshotsResponse,
  type RepositoriesListResponse,
  type RepositoryDto,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { DeletionService } from "./deletion.service";
import { RepositoriesService } from "./repositories.service";
import { SnapshotPruneService } from "./snapshot-prune.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (GITHUB_CONNECTOR_SERVICE_PLAN.md "APIs").
 */
@Controller("internal/repositories")
@UseGuards(InternalAuthGuard)
export class RepositoriesInternalController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly deletion: DeletionService,
    private readonly prune: SnapshotPruneService
  ) {}

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

  /**
   * Fast, synchronous half of deletion (DATA_RETENTION_AND_PRIVACY.md
   * "Repository deletion" step 1) — `api` calls this directly so the
   * repository disappears from the user's list immediately. The full
   * cascade and S3 cleanup happen asynchronously off `repo.deleted`, which
   * `api` publishes right after this call returns.
   */
  @Delete(":repoId")
  @HttpCode(202)
  async softDelete(@Param("repoId") repoId: string): Promise<{ status: "deleting" }> {
    await this.repositories.softDelete(repoId);
    return { status: "deleting" };
  }

  /** The snapshot ids `indexer` currently retains for a repo — `ai` uses this after `snapshot.prune` to know which `snapshot_chunks` rows are still valid. */
  @Get(":repoId/snapshots")
  async listSnapshots(@Param("repoId") repoId: string): Promise<InternalRepositorySnapshotsResponse> {
    const snapshotIds = await this.prune.listRetainedSnapshotIds(repoId);
    return { snapshotIds };
  }
}
