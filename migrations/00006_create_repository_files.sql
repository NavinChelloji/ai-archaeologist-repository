-- migrate:up
CREATE TABLE IF NOT EXISTS repository_files (
  id            uuid PRIMARY KEY,
  repo_id       uuid NOT NULL,
  snapshot_id   uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  path          text NOT NULL,
  directory     text NOT NULL,
  extension     text,
  language      text,
  size_bytes    integer NOT NULL,
  line_count    integer NOT NULL DEFAULT 0,
  content_hash  text NOT NULL,
  object_key    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, path)
);

CREATE INDEX IF NOT EXISTS idx_repository_files_repo_snapshot
  ON repository_files (repo_id, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_repository_files_snapshot_dir
  ON repository_files (snapshot_id, directory);

-- migrate:down
DROP TABLE IF EXISTS repository_files;
