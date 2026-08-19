-- migrate:up
CREATE TABLE IF NOT EXISTS processed_events (
  event_id uuid NOT NULL,
  consumer text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

-- migrate:down
DROP TABLE IF EXISTS processed_events;
