-- migrate:up
CREATE TABLE IF NOT EXISTS job_stage_events (
  id              uuid PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  stage           text NOT NULL,
  event_type      text NOT NULL,
  items_processed integer,
  total_items     integer,
  duration_ms     integer,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_stage_events_job_created
  ON job_stage_events (job_id, created_at ASC);

-- migrate:down
DROP TABLE IF EXISTS job_stage_events;
