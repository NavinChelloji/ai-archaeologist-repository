import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { RepositoriesModule } from "../repositories/repositories.module";
import { JobRetentionSweeperService } from "./job-retention-sweeper.service";
import { JobStageEventsRepository } from "./job-stage-events.repository";
import { PipelineInternalController } from "./pipeline.internal.controller";
import { PipelineService } from "./pipeline.service";
import { ProcessingJobsRepository } from "./processing-jobs.repository";
import { ProgressPublisherService } from "./progress-publisher.service";
import { QueueMetricsSweeperService } from "./queue-metrics-sweeper.service";
import { StalledJobSweeperService } from "./stalled-job-sweeper.service";
import { PipelineWorkersService } from "./workers/pipeline-workers.service";

@Module({
  imports: [ConfigModule, InternalModule, RepositoriesModule],
  controllers: [PipelineInternalController],
  providers: [
    PipelineService,
    ProcessingJobsRepository,
    JobStageEventsRepository,
    ProgressPublisherService,
    PipelineWorkersService,
    StalledJobSweeperService,
    JobRetentionSweeperService,
    QueueMetricsSweeperService,
  ],
})
export class PipelineModule {}
