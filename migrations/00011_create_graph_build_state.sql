-- migrate:up
CREATE TABLE IF NOT EXISTS graph_build_state (
  snapshot_id         uuid PRIMARY KEY REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  repo_id             uuid NOT NULL,
  files_ready         boolean NOT NULL DEFAULT false,
  symbols_ready       boolean NOT NULL DEFAULT false,
  dependencies_ready  boolean NOT NULL DEFAULT false,
  built_at            timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS graph_build_state;
