-- migrate:up
CREATE TABLE IF NOT EXISTS code_symbols (
  id                uuid PRIMARY KEY,
  repo_id           uuid NOT NULL,
  snapshot_id       uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  file_id           uuid NOT NULL REFERENCES repository_files(id) ON DELETE CASCADE,
  parent_symbol_id  uuid REFERENCES code_symbols(id) ON DELETE CASCADE,
  symbol_type       text NOT NULL,
  name              text NOT NULL,
  qualified_name    text,
  signature         text,
  is_exported       boolean NOT NULL DEFAULT false,
  start_line        integer NOT NULL,
  end_line          integer NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_repo_snapshot_type
  ON code_symbols (repo_id, snapshot_id, symbol_type);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file
  ON code_symbols (file_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name
  ON code_symbols (snapshot_id, lower(name));

-- migrate:down
DROP TABLE IF EXISTS code_symbols;
