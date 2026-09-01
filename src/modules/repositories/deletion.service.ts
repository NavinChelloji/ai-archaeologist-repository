import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@aca/logger";
import { deleteObjectsByPrefix, repositoryPrefix, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, S3_CLIENT } from "../../shared/infra.module";
import { RepositoriesRepository } from "./repositories.repository";

/**
 * Cleanup for `repo.deleted` and `user.deleted`
 * (DATA_RETENTION_AND_PRIVACY.md "Deletion"). Every step here is idempotent
 * so retried delivery of the same event is safe (EVENT_CONTRACTS.md "Steps
 * 2-4 are idempotent and retried on failure").
 */
@Injectable()
export class DeletionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly repositories: RepositoriesRepository
  ) {}

  /**
   * Full deletion path for one repository: soft-delete (in case `api`'s
   * synchronous call didn't land, e.g. this is a retry), hard-delete
   * cascading to every child table, then remove the S3 prefix.
   */
  async deleteRepository(repoId: string): Promise<void> {
    await this.repositories.softDelete(repoId);
    await this.repositories.hardDelete(repoId);

    const deletedObjects = await deleteObjectsByPrefix(this.s3, this.config.S3_BUCKET, repositoryPrefix(repoId));
    this.logger.info({ repoId, deletedObjects }, "repository deleted");
  }

  /**
   * Account deletion: delete every repo the event already knows about, plus
   * a safety-net re-query by owner in case a repo was imported in the race
   * window between `api` enumerating repos and this handler running.
   */
  async deleteForUser(userId: string, repoIds: readonly string[]): Promise<void> {
    const stragglers = await this.repositories.listAllIdsByOwner(userId);
    const allRepoIds = new Set([...repoIds, ...stragglers]);

    for (const repoId of allRepoIds) {
      await this.deleteRepository(repoId);
    }
    this.logger.info({ userId, repoCount: allRepoIds.size }, "account's repositories deleted");
  }
}
