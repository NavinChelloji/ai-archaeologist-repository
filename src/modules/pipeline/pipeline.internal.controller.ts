import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AppError, type ProcessingJobDto } from "@aca/contracts";
import { InternalAuthGuard } from "../../internal/internal-auth.guard";
import { toProcessingJobDto } from "./mappers";
import { PipelineService } from "./pipeline.service";

/**
 * `/internal/*` — never routed from the public ingress, always behind
 * InternalAuthGuard (RULES.md #12). `api` is the only caller
 * (JOB_ORCHESTRATOR_SERVICE_PLAN.md "APIs").
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class PipelineInternalController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get("jobs/:jobId")
  async getJob(@Param("jobId") jobId: string): Promise<ProcessingJobDto> {
    const job = await this.pipeline.getJob(jobId);
    if (!job) throw new AppError("JOB_NOT_FOUND", "This job does not exist.");
    return toProcessingJobDto(job);
  }

  @Get("repositories/:repoId/job")
  async getLatestJobForRepo(@Param("repoId") repoId: string): Promise<ProcessingJobDto> {
    const job = await this.pipeline.getLatestJobForRepo(repoId);
    if (!job) throw new AppError("JOB_NOT_FOUND", "No indexing job has been requested for this repository.");
    return toProcessingJobDto(job);
  }

  @Post("jobs/:jobId/retry")
  async retryJob(@Param("jobId") jobId: string): Promise<ProcessingJobDto> {
    const job = await this.pipeline.retryJob(jobId);
    return toProcessingJobDto(job);
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string): Promise<ProcessingJobDto> {
    const job = await this.pipeline.cancelJob(jobId);
    return toProcessingJobDto(job);
  }
}
