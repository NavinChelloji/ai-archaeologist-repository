import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { query } from "@aca/db";
import { PG_POOL } from "../../shared/infra.module";

export interface RepositoryRow {
  id: string;
  owner_user_id: string;
  provider: string;
  provider_repo_id: string;
  full_name: string;
  default_branch: string;
  is_private: boolean;
  primary_language: string | null;
  active_snapshot_id: string | null;
  metadata: Record<string, unknown>;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertRepositoryInput {
  ownerUserId: string;
  provider: string;
  providerRepoId: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  primaryLanguage: string | null;
}

export interface UpsertRepositoryResult {
  row: RepositoryRow;
  created: boolean;
}

export interface ListByOwnerCursor {
  updatedAt: Date;
  id: string;
}

export interface ListByOwnerInput {
  ownerUserId: string;
  pageSize: number;
  cursor: ListByOwnerCursor | null;
}

/** Data access for `repositories` (GITHUB_CONNECTOR_SERVICE_PLAN.md "Repositories and Snapshots Module"). */
@Injectable()
export class RepositoriesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Re-import at the same `(owner_user_id, provider, provider_repo_id)` updates the row rather than creating a duplicate. */
  async upsert(input: UpsertRepositoryInput): Promise<UpsertRepositoryResult> {
    const rows = await query<RepositoryRow & { inserted: boolean }>(
      this.pool,
      `INSERT INTO repositories (
         id, owner_user_id, provider, provider_repo_id, full_name,
         default_branch, is_private, primary_language, deleted_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,now())
       ON CONFLICT (owner_user_id, provider, provider_repo_id) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         default_branch = EXCLUDED.default_branch,
         is_private = EXCLUDED.is_private,
         primary_language = EXCLUDED.primary_language,
         deleted_at = NULL,
         updated_at = now()
       RETURNING *, (xmax = 0) AS inserted`,
      [
        randomUUID(),
        input.ownerUserId,
        input.provider,
        input.providerRepoId,
        input.fullName,
        input.defaultBranch,
        input.isPrivate,
        input.primaryLanguage,
      ]
    );
    // INSERT ... ON CONFLICT DO UPDATE ... RETURNING always yields exactly one row.
    const row = rows[0]!;
    return { row, created: row.inserted };
  }

  async findByProviderRepo(ownerUserId: string, provider: string, providerRepoId: string): Promise<RepositoryRow | null> {
    const rows = await query<RepositoryRow>(
      this.pool,
      "SELECT * FROM repositories WHERE owner_user_id = $1 AND provider = $2 AND provider_repo_id = $3 AND deleted_at IS NULL",
      [ownerUserId, provider, providerRepoId]
    );
    return rows[0] ?? null;
  }

  async findById(repoId: string): Promise<RepositoryRow | null> {
    const rows = await query<RepositoryRow>(
      this.pool,
      "SELECT * FROM repositories WHERE id = $1 AND deleted_at IS NULL",
      [repoId]
    );
    return rows[0] ?? null;
  }

  /** Existence + ownership in one query — a nonexistent repo and a wrong-owner repo both come back as "no row" (RULES.md #13). */
  async isOwnedBy(repoId: string, userId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.pool,
      "SELECT id FROM repositories WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
      [repoId, userId]
    );
    return rows.length > 0;
  }

  /** Atomic cutover (CODEBASE.md "Snapshot Lifecycle"): a single-row, single-column update is already atomic in Postgres. */
  async activateSnapshot(repoId: string, snapshotId: string): Promise<void> {
    await query(this.pool, "UPDATE repositories SET active_snapshot_id = $2, updated_at = now() WHERE id = $1", [
      repoId,
      snapshotId,
    ]);
  }

  async countActiveByOwner(ownerUserId: string): Promise<number> {
    const rows = await query<{ count: string }>(
      this.pool,
      "SELECT count(*)::text AS count FROM repositories WHERE owner_user_id = $1 AND deleted_at IS NULL",
      [ownerUserId]
    );
    return Number(rows[0]?.count ?? "0");
  }

  /**
   * Immediate, synchronous half of deletion (DATA_RETENTION_AND_PRIVACY.md
   * "Repository deletion" step 1) — the repository disappears from the
   * user's list right away. Idempotent: a second call against an
   * already-soft-deleted row matches zero rows.
   */
  async softDelete(repoId: string): Promise<void> {
    await query(
      this.pool,
      "UPDATE repositories SET deleted_at = now(), active_snapshot_id = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [repoId]
    );
  }

  /**
   * The cascading half of deletion, run from the `repo.deleted` consumer.
   * `ON DELETE CASCADE` on every child table (snapshots, processing jobs,
   * files, symbols, dependencies, graph nodes/edges) means this one
   * statement removes all of `indexer`'s data for the repository. Idempotent
   * — deleting an already-gone id matches zero rows.
   */
  async hardDelete(repoId: string): Promise<void> {
    await query(this.pool, "DELETE FROM repositories WHERE id = $1", [repoId]);
  }

  /**
   * Safety net for account deletion (DATA_RETENTION_AND_PRIVACY.md "Account
   * deletion"): `api` enumerates a user's repos to build the `repoIds` on
   * `user.deleted`, but a repo imported in the race window between that
   * enumeration and this handler running would otherwise survive. Re-querying
   * by `owner_user_id` here catches it.
   */
  async listAllIdsByOwner(ownerUserId: string): Promise<string[]> {
    const rows = await query<{ id: string }>(
      this.pool,
      "SELECT id FROM repositories WHERE owner_user_id = $1 AND deleted_at IS NULL",
      [ownerUserId]
    );
    return rows.map((row) => row.id);
  }

  async listByOwner(input: ListByOwnerInput): Promise<RepositoryRow[]> {
    if (input.cursor) {
      return query<RepositoryRow>(
        this.pool,
        `SELECT * FROM repositories
         WHERE owner_user_id = $1 AND deleted_at IS NULL AND (updated_at, id) < ($2, $3)
         ORDER BY updated_at DESC, id DESC
         LIMIT $4`,
        [input.ownerUserId, input.cursor.updatedAt, input.cursor.id, input.pageSize]
      );
    }

    return query<RepositoryRow>(
      this.pool,
      `SELECT * FROM repositories
       WHERE owner_user_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [input.ownerUserId, input.pageSize]
    );
  }
}
