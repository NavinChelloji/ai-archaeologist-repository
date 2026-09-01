import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { JobStage, JobStatus } from "@aca/contracts";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface ProcessingJobRow {
  id: string;
  repo_id: string;
  snapshot_id: string | null;
  requested_by: string;
  status: JobStatus;
  current_stage: JobStage;
  progress_percent: number;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
  correlation_id: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateJobInput {
  id: string;
  repoId: string;
  requestedBy: string;
  correlationId: string;
}

export interface AdvanceStageInput {
  stage: JobStage;
  status: JobStatus;
  progressPercent: number;
  message?: string | null;
  snapshotId?: string | null;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === UNIQUE_VIOLATION;
}

/** Data access for `processing_jobs` (JOB_ORCHESTRATOR_SERVICE_PLAN.md "Database Ownership"). */
@Injectable()
export class ProcessingJobsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Returns `null` instead of throwing when a job is already active for
   * this repo — `uq_processing_jobs_active_per_repo` makes "one active job
   * per repository" a database guarantee, and a concurrent import racing
   * this insert is expected, not exceptional (RULES.md #16 "test duplicate
   * job delivery").
   */
  async create(input: CreateJobInput): Promise<ProcessingJobRow | null> {
    try {
      const rows = await query<ProcessingJobRow>(
        this.pool,
        `INSERT INTO processing_jobs (
           id, repo_id, requested_by, status, current_stage, progress_percent,
           retry_count, correlation_id, started_at, updated_at
         ) VALUES ($1,$2,$3,'queued','queued',0,0,$4,now(),now())
         RETURNING *`,
        [input.id, input.repoId, input.requestedBy, input.correlationId]
      );
      return rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async findById(jobId: string): Promise<ProcessingJobRow | null> {
    const rows = await query<ProcessingJobRow>(this.pool, "SELECT * FROM processing_jobs WHERE id = $1", [jobId]);
    return rows[0] ?? null;
  }

  /** The row the partial unique index guards — status IN ('queued','running'). */
  async findActiveByRepoId(repoId: string): Promise<ProcessingJobRow | null> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      "SELECT * FROM processing_jobs WHERE repo_id = $1 AND status IN ('queued','running')",
      [repoId]
    );
    return rows[0] ?? null;
  }

  /** "Latest job state" (API_GATEWAY_SERVICE_PLAN.md) — regardless of whether it's still active. */
  async findLatestByRepoId(repoId: string): Promise<ProcessingJobRow | null> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      "SELECT * FROM processing_jobs WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 1",
      [repoId]
    );
    return rows[0] ?? null;
  }

  async advanceStage(jobId: string, input: AdvanceStageInput): Promise<ProcessingJobRow> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      `UPDATE processing_jobs SET
         current_stage = $2,
         status = $3,
         progress_percent = $4,
         snapshot_id = COALESCE($5, snapshot_id),
         completed_at = CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [jobId, input.stage, input.status, input.progressPercent, input.snapshotId ?? null]
    );
    return rows[0]!;
  }

  async updateProgress(jobId: string, progressPercent: number): Promise<void> {
    await query(this.pool, "UPDATE processing_jobs SET progress_percent = $2, updated_at = now() WHERE id = $1", [
      jobId,
      progressPercent,
    ]);
  }

  async incrementRetry(jobId: string): Promise<ProcessingJobRow> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      "UPDATE processing_jobs SET retry_count = retry_count + 1, updated_at = now() WHERE id = $1 RETURNING *",
      [jobId]
    );
    return rows[0]!;
  }

  async resetRetryCount(jobId: string): Promise<void> {
    await query(this.pool, "UPDATE processing_jobs SET retry_count = 0, updated_at = now() WHERE id = $1", [jobId]);
  }

  async markFailed(jobId: string, errorCode: string, errorMessage: string): Promise<ProcessingJobRow> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      `UPDATE processing_jobs SET
         status = 'failed', current_stage = 'failed',
         error_code = $2, error_message = $3,
         completed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [jobId, errorCode, errorMessage]
    );
    return rows[0]!;
  }

  async markCancelled(jobId: string): Promise<ProcessingJobRow> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      `UPDATE processing_jobs SET status = 'cancelled', current_stage = 'cancelled', completed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [jobId]
    );
    return rows[0]!;
  }

  /** Resumes a failed job into a specific stage — used by both automatic and manual retry. */
  async resumeIntoStage(jobId: string, stage: JobStage, progressPercent: number): Promise<ProcessingJobRow> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      `UPDATE processing_jobs SET
         status = 'running', current_stage = $2, progress_percent = $3,
         error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [jobId, stage, progressPercent]
    );
    return rows[0]!;
  }

  /** `STAGE_TIMEOUT_SECONDS` sweep target — a running job whose last update predates the cutoff. */
  async findStalled(olderThan: Date): Promise<ProcessingJobRow[]> {
    return query<ProcessingJobRow>(
      this.pool,
      "SELECT * FROM processing_jobs WHERE status IN ('queued','running') AND updated_at < $1",
      [olderThan]
    );
  }

  /** Oldest still-in-flight job, for the "job age" gauge (RULES.md #15) — an old queued/running job is the clearest sign the pipeline is stuck. */
  async findOldestActive(): Promise<ProcessingJobRow | null> {
    const rows = await query<ProcessingJobRow>(
      this.pool,
      "SELECT * FROM processing_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT 1"
    );
    return rows[0] ?? null;
  }

  /**
   * `JOB_EVENT_RETENTION_DAYS` sweep target (DATA_RETENTION_AND_PRIVACY.md
   * "Job records and stage events"). Only terminal jobs are eligible — a
   * running or queued job is never deleted regardless of age. Cascades to
   * `job_stage_events`. Returns the count removed for the sweeper's log line.
   */
  async deleteTerminalOlderThan(olderThan: Date): Promise<number> {
    const rows = await query<{ id: string }>(
      this.pool,
      "DELETE FROM processing_jobs WHERE status IN ('completed','failed','cancelled') AND completed_at < $1 RETURNING id",
      [olderThan]
    );
    return rows.length;
  }
}
