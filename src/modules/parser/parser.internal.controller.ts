import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  InternalFileContentQuerySchema,
  InternalRepositoryFilesQuerySchema,
  InternalRepositorySymbolsQuerySchema,
  type InternalFileContentQuery,
  type InternalFileContentResponse,
  type InternalRepositoryFilesQuery,
  type InternalRepositoryFilesResponse,
  type InternalRepositorySymbolsQuery,
  type InternalRepositorySymbolsResponse,
  type RepositoryFileDto,
} from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { ZodValidationPipe } from "../../shared/validation/zod-validation.pipe";
import { ParserReadService } from "./parser-read.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "APIs").
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class ParserInternalController {
  constructor(private readonly parserRead: ParserReadService) {}

  @Get("repositories/:repoId/files")
  async listFiles(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(InternalRepositoryFilesQuerySchema)) query: InternalRepositoryFilesQuery
  ): Promise<InternalRepositoryFilesResponse> {
    return this.parserRead.listFiles(repoId, query);
  }

  @Get("files/:fileId")
  async getFile(@Param("fileId") fileId: string): Promise<RepositoryFileDto> {
    return this.parserRead.getFile(fileId);
  }

  @Get("files/:fileId/content")
  async getFileContent(
    @Param("fileId") fileId: string,
    @Query(new ZodValidationPipe(InternalFileContentQuerySchema)) query: InternalFileContentQuery
  ): Promise<InternalFileContentResponse> {
    return this.parserRead.getFileContent(fileId, query);
  }

  @Get("repositories/:repoId/symbols")
  async listSymbols(
    @Param("repoId") repoId: string,
    @Query(new ZodValidationPipe(InternalRepositorySymbolsQuerySchema)) query: InternalRepositorySymbolsQuery
  ): Promise<InternalRepositorySymbolsResponse> {
    return this.parserRead.listSymbols(repoId, query);
  }
}
