-- migrate:up
CREATE TABLE IF NOT EXISTS repository_snapshots (
  id             uuid PRIMARY KEY,
  repo_id        uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha     text NOT NULL,
  ref            text NOT NULL,
  archive_key    text,
  manifest_key   text,
  size_bytes     bigint,
  file_count     integer,
  status         text NOT NULL,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_created
  ON repository_snapshots (repo_id, created_at DESC);

ALTER TABLE repositories
  ADD CONSTRAINT fk_repositories_active_snapshot
  FOREIGN KEY (active_snapshot_id) REFERENCES repository_snapshots(id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS fk_repositories_active_snapshot;
DROP TABLE IF EXISTS repository_snapshots;
