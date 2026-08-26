-- migrate:up
CREATE TABLE IF NOT EXISTS file_dependencies (
  id                 uuid PRIMARY KEY,
  repo_id            uuid NOT NULL,
  snapshot_id        uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  source_file_id     uuid NOT NULL REFERENCES repository_files(id) ON DELETE CASCADE,
  target_file_id     uuid REFERENCES repository_files(id) ON DELETE CASCADE,
  target_path        text,
  external_package   text,
  raw_specifier      text NOT NULL,
  import_kind        text NOT NULL,
  resolution_status  text NOT NULL,
  line               integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_dependencies_source
  ON file_dependencies (source_file_id);
CREATE INDEX IF NOT EXISTS idx_file_dependencies_target
  ON file_dependencies (target_file_id);
CREATE INDEX IF NOT EXISTS idx_file_dependencies_repo_snapshot_status
  ON file_dependencies (repo_id, snapshot_id, resolution_status);

-- migrate:down
DROP TABLE IF EXISTS file_dependencies;
