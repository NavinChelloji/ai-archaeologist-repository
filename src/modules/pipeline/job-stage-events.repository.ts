import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface JobStageEventRow {
  id: string;
  job_id: string;
  stage: string;
  event_type: string;
  items_processed: number | null;
  total_items: number | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface RecordEventInput {
  jobId: string;
  stage: string;
  eventType: string;
  itemsProcessed?: number | null;
  totalItems?: number | null;
  durationMs?: number | null;
  payload: Record<string, unknown>;
}

/**
 * Data access for `job_stage_events` — backs the user-visible indexing
 * timeline (JOB_ORCHESTRATOR_SERVICE_PLAN.md) and doubles as the replay
 * source for stage retries: every consumed envelope's payload is logged
 * here, so a retry can look up "the last payload that triggered entry into
 * this stage" without a dedicated bookkeeping column.
 */
@Injectable()
export class JobStageEventsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(input: RecordEventInput): Promise<JobStageEventRow> {
    const rows = await query<JobStageEventRow>(
      this.pool,
      `INSERT INTO job_stage_events (id, job_id, stage, event_type, items_processed, total_items, duration_ms, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        randomUUID(),
        input.jobId,
        input.stage,
        input.eventType,
        input.itemsProcessed ?? null,
        input.totalItems ?? null,
        input.durationMs ?? null,
        input.payload,
      ]
    );
    return rows[0]!;
  }

  /** Most recent payload logged for a given event type — the replay source for stage retries. */
  async findLatestByEventType(jobId: string, eventType: string): Promise<JobStageEventRow | null> {
    const rows = await query<JobStageEventRow>(
      this.pool,
      "SELECT * FROM job_stage_events WHERE job_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
      [jobId, eventType]
    );
    return rows[0] ?? null;
  }

  /** Most recent `repo.stage.failed` event for a job — tells manual retry which stage to resume. */
  async findLatestFailure(jobId: string): Promise<JobStageEventRow | null> {
    const rows = await query<JobStageEventRow>(
      this.pool,
      "SELECT * FROM job_stage_events WHERE job_id = $1 AND event_type = 'repo.stage.failed' ORDER BY created_at DESC LIMIT 1",
      [jobId]
    );
    return rows[0] ?? null;
  }

  async listForJob(jobId: string): Promise<JobStageEventRow[]> {
    return query<JobStageEventRow>(
      this.pool,
      "SELECT * FROM job_stage_events WHERE job_id = $1 ORDER BY created_at ASC",
      [jobId]
    );
  }
}
