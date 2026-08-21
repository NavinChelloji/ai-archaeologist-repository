-- migrate:up
CREATE TABLE IF NOT EXISTS processing_jobs (
  id                uuid PRIMARY KEY,
  repo_id           uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id       uuid REFERENCES repository_snapshots(id) ON DELETE SET NULL,
  requested_by      uuid NOT NULL,
  status            text NOT NULL,
  current_stage     text NOT NULL,
  progress_percent  integer NOT NULL DEFAULT 0,
  retry_count       integer NOT NULL DEFAULT 0,
  error_code        text,
  error_message     text,
  correlation_id    uuid NOT NULL,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_repo_created
  ON processing_jobs (repo_id, created_at DESC);

-- Makes "one active job per repository" a database guarantee rather than an
-- application convention (JOB_ORCHESTRATOR_SERVICE_PLAN.md) — the cheapest
-- possible defence against duplicate imports racing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_processing_jobs_active_per_repo
  ON processing_jobs (repo_id)
  WHERE status IN ('queued','running');

-- migrate:down
DROP TABLE IF EXISTS processing_jobs;
