import type { ProcessingJobDto } from "@aca/contracts";
import type { ProcessingJobRow } from "./processing-jobs.repository";

export function toProcessingJobDto(row: ProcessingJobRow): ProcessingJobDto {
  return {
    jobId: row.id,
    repoId: row.repo_id,
    snapshotId: row.snapshot_id,
    status: row.status,
    stage: row.current_stage,
    progressPercent: row.progress_percent,
    message: null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
