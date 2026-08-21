import { describe, expect, it, vi } from "vitest";
import { AppError } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { RepositoriesService } from "./repositories.service";
import type { RepositoryRow } from "./repositories.repository";

const config = { MAX_REPOSITORIES_PER_USER: 2, MAX_REPOSITORY_ARCHIVE_MB: 500 } as IndexerEnv;

function makeRow(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    id: "repo-1",
    owner_user_id: "user-1",
    provider: "github",
    provider_repo_id: "123",
    full_name: "octocat/hello-world",
    default_branch: "main",
    is_private: false,
    primary_language: "TypeScript",
    active_snapshot_id: null,
    metadata: {},
    deleted_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepositoriesRepository(initial: RepositoryRow[] = []) {
  const rows = [...initial];

  return {
    findByProviderRepo: vi.fn(async (ownerUserId: string, provider: string, providerRepoId: string) =>
      rows.find(
        (r) => r.owner_user_id === ownerUserId && r.provider === provider && r.provider_repo_id === providerRepoId
      ) ?? null
    ),
    countActiveByOwner: vi.fn(async (ownerUserId: string) => rows.filter((r) => r.owner_user_id === ownerUserId).length),
    upsert: vi.fn(async (input: { ownerUserId: string; provider: string; providerRepoId: string; fullName: string; defaultBranch: string; isPrivate: boolean; primaryLanguage: string | null }) => {
      const existing = rows.find(
        (r) => r.owner_user_id === input.ownerUserId && r.provider === input.provider && r.provider_repo_id === input.providerRepoId
      );
      if (existing) {
        existing.full_name = input.fullName;
        existing.default_branch = input.defaultBranch;
        existing.is_private = input.isPrivate;
        existing.primary_language = input.primaryLanguage;
        existing.updated_at = new Date();
        return { row: existing, created: false };
      }
      const row = makeRow({
        id: `repo-${rows.length + 1}`,
        owner_user_id: input.ownerUserId,
        provider_repo_id: input.providerRepoId,
        full_name: input.fullName,
        default_branch: input.defaultBranch,
        is_private: input.isPrivate,
        primary_language: input.primaryLanguage,
      });
      rows.push(row);
      return { row, created: true };
    }),
    findById: vi.fn(async (repoId: string) => rows.find((r) => r.id === repoId) ?? null),
    isOwnedBy: vi.fn(async (repoId: string, userId: string) =>
      rows.some((r) => r.id === repoId && r.owner_user_id === userId)
    ),
    listByOwner: vi.fn(async () => rows),
  };
}

function fakeGithubTokenClient() {
  return { fetchToken: vi.fn(async () => "gh-token") };
}

function fakeGithubRepoClient(details: { sizeKb?: number } = {}) {
  return {
    fetchById: vi.fn(async (providerRepoId: string) => ({
      providerRepoId,
      fullName: "octocat/hello-world",
      defaultBranch: "main",
      isPrivate: false,
      primaryLanguage: "TypeScript",
      sizeKb: details.sizeKb ?? 100,
    })),
  };
}

describe("RepositoriesService.import", () => {
  it("mints a new repoId on first import", async () => {
    const repositories = fakeRepositoriesRepository();
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient() as never,
      config
    );

    const result = await service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "123" });

    expect(result.created).toBe(true);
    expect(result.repository.repoId).toBeTruthy();
  });

  it("re-importing the same repository updates the existing row instead of duplicating it", async () => {
    const repositories = fakeRepositoriesRepository();
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient() as never,
      config
    );

    const first = await service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "123" });
    const second = await service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "123" });

    expect(second.created).toBe(false);
    expect(second.repository.repoId).toBe(first.repository.repoId);
    expect(repositories.upsert).toHaveBeenCalledTimes(2);
  });

  it("rejects a new import past MAX_REPOSITORIES_PER_USER", async () => {
    const repositories = fakeRepositoriesRepository([
      makeRow({ id: "repo-a", provider_repo_id: "111" }),
      makeRow({ id: "repo-b", provider_repo_id: "222" }),
    ]);
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient() as never,
      config
    );

    await expect(service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "333" })).rejects.toMatchObject({
      code: "REPO_LIMIT_REACHED",
    });
  });

  it("does not enforce the quota when re-importing an already-owned repository", async () => {
    const repositories = fakeRepositoriesRepository([
      makeRow({ id: "repo-a", provider_repo_id: "111" }),
      makeRow({ id: "repo-b", provider_repo_id: "222" }),
    ]);
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient() as never,
      config
    );

    const result = await service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "111" });
    expect(result.created).toBe(false);
  });

  it("rejects an oversized repository before creating a row", async () => {
    const repositories = fakeRepositoriesRepository();
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient({ sizeKb: 999_999 }) as never,
      config
    );

    await expect(service.import({ ownerUserId: "user-1", provider: "github", providerRepoId: "123" })).rejects.toMatchObject({
      code: "REPO_TOO_LARGE",
    });
    expect(repositories.upsert).not.toHaveBeenCalled();
  });
});

describe("RepositoriesService.getById", () => {
  it("throws REPO_NOT_FOUND for a missing repository", async () => {
    const repositories = fakeRepositoriesRepository();
    const service = new RepositoriesService(
      repositories as never,
      fakeGithubTokenClient() as never,
      fakeGithubRepoClient() as never,
      config
    );

    await expect(service.getById("nope")).rejects.toBeInstanceOf(AppError);
  });
});
