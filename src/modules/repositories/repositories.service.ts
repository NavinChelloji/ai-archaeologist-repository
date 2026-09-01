import { Inject, Injectable } from "@nestjs/common";
import { AppError, type RepositoryDto } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { GithubRepoClient } from "./github-repo.client";
import { GithubTokenClient } from "./github-token.client";
import { decodeCursor, encodeCursor } from "./list-cursor";
import { toRepositoryDto } from "./mappers";
import { RepositoriesRepository } from "./repositories.repository";

export interface ImportInput {
  ownerUserId: string;
  provider: "github";
  providerRepoId: string;
}

export interface ImportResult {
  repository: RepositoryDto;
  created: boolean;
}

export interface ListResult {
  repositories: RepositoryDto[];
  nextCursor: string | null;
}

const BYTES_PER_MB_IN_KB = 1024;

/**
 * Owns repository identity and import (GITHUB_CONNECTOR_SERVICE_PLAN.md).
 * `repoId` is minted here and nowhere else.
 */
@Injectable()
export class RepositoriesService {
  constructor(
    private readonly repositories: RepositoriesRepository,
    private readonly githubTokens: GithubTokenClient,
    private readonly githubRepos: GithubRepoClient,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv
  ) {}

  async import(input: ImportInput): Promise<ImportResult> {
    const existing = await this.repositories.findByProviderRepo(
      input.ownerUserId,
      input.provider,
      input.providerRepoId
    );

    if (!existing) {
      const count = await this.repositories.countActiveByOwner(input.ownerUserId);
      if (count >= this.config.MAX_REPOSITORIES_PER_USER) {
        throw new AppError(
          "REPO_LIMIT_REACHED",
          `You can import up to ${this.config.MAX_REPOSITORIES_PER_USER} repositories.`
        );
      }
    }

    const token = await this.githubTokens.fetchToken(input.ownerUserId);
    const details = await this.githubRepos.fetchById(input.providerRepoId, token);

    const sizeMb = details.sizeKb / BYTES_PER_MB_IN_KB;
    if (sizeMb > this.config.MAX_REPOSITORY_ARCHIVE_MB) {
      throw new AppError(
        "REPO_TOO_LARGE",
        `This repository is larger than the ${this.config.MAX_REPOSITORY_ARCHIVE_MB} MB import limit.`
      );
    }

    const { row, created } = await this.repositories.upsert({
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      providerRepoId: details.providerRepoId,
      fullName: details.fullName,
      defaultBranch: details.defaultBranch,
      isPrivate: details.isPrivate,
      primaryLanguage: details.primaryLanguage,
    });

    return { repository: toRepositoryDto(row), created };
  }

  async getById(repoId: string): Promise<RepositoryDto> {
    const row = await this.repositories.findById(repoId);
    if (!row) {
      throw new AppError("REPO_NOT_FOUND", "This repository does not exist.");
    }
    return toRepositoryDto(row);
  }

  async isOwnedBy(repoId: string, userId: string): Promise<boolean> {
    return this.repositories.isOwnedBy(repoId, userId);
  }

  /** DATA_RETENTION_AND_PRIVACY.md "Repository deletion" step 1 — immediate, synchronous, idempotent. */
  async softDelete(repoId: string): Promise<void> {
    await this.repositories.softDelete(repoId);
  }

  /** Called by the Pipeline module on `repo.processing.completed` (CODEBASE.md "Snapshot Lifecycle" — cutover is atomic). */
  async activateSnapshot(repoId: string, snapshotId: string): Promise<void> {
    await this.repositories.activateSnapshot(repoId, snapshotId);
  }

  async listByOwner(ownerUserId: string, pageSize: number, cursor: string | undefined): Promise<ListResult> {
    let decoded = null;
    if (cursor) {
      try {
        decoded = decodeCursor(cursor);
      } catch {
        throw new AppError("VALIDATION_FAILED", "This page cursor is invalid.");
      }
    }

    const rows = await this.repositories.listByOwner({ ownerUserId, pageSize, cursor: decoded });
    const nextCursor = rows.length === pageSize ? encodeCursor(rows[rows.length - 1]!) : null;

    return { repositories: rows.map(toRepositoryDto), nextCursor };
  }
}
