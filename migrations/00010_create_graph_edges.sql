-- migrate:up
CREATE TABLE IF NOT EXISTS graph_edges (
  id              uuid PRIMARY KEY,
  repo_id         uuid NOT NULL,
  snapshot_id     uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  graph_type      text NOT NULL,
  source_node_id  uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_node_id  uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  edge_type       text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, source_node_id, target_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_source
  ON graph_edges (source_node_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target
  ON graph_edges (target_node_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_repo_snapshot_type
  ON graph_edges (repo_id, snapshot_id, graph_type);

-- migrate:down
DROP TABLE IF EXISTS graph_edges;
