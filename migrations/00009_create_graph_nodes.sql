-- migrate:up
CREATE TABLE IF NOT EXISTS graph_nodes (
  id           uuid PRIMARY KEY,
  repo_id      uuid NOT NULL,
  snapshot_id  uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  graph_type   text NOT NULL,
  node_type    text NOT NULL,
  label        text NOT NULL,
  path         text,
  ref_id       uuid,
  degree       integer NOT NULL DEFAULT 0,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, graph_type, node_type, label, path)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_repo_snapshot_type
  ON graph_nodes (repo_id, snapshot_id, graph_type, node_type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_degree
  ON graph_nodes (snapshot_id, graph_type, degree DESC);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_label_search
  ON graph_nodes (snapshot_id, lower(label));

-- migrate:down
DROP TABLE IF EXISTS graph_nodes;
