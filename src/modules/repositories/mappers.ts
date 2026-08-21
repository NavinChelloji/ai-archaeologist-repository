import type { RepositoryDto } from "@aca/contracts";
import type { RepositoryRow } from "./repositories.repository";

export function toRepositoryDto(row: RepositoryRow): RepositoryDto {
  return {
    repoId: row.id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    isPrivate: row.is_private,
    primaryLanguage: row.primary_language,
    activeSnapshotId: row.active_snapshot_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
