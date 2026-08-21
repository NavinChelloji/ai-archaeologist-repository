-- migrate:up
CREATE TABLE IF NOT EXISTS repositories (
  id                  uuid PRIMARY KEY,
  owner_user_id       uuid NOT NULL,
  provider            text NOT NULL DEFAULT 'github',
  provider_repo_id    text NOT NULL,
  full_name           text NOT NULL,
  default_branch      text NOT NULL,
  is_private          boolean NOT NULL DEFAULT false,
  primary_language    text,
  active_snapshot_id  uuid,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, provider, provider_repo_id)
);

CREATE INDEX IF NOT EXISTS idx_repositories_owner
  ON repositories (owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;

-- migrate:down
DROP TABLE IF EXISTS repositories;
