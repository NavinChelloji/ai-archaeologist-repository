import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import { GithubTarballClient } from "./github-tarball.client";

function config(): IndexerEnv {
  return {
    GITHUB_API_BASE_URL: "https://api.github.com",
    MAX_REPOSITORY_ARCHIVE_MB: 500,
    DOWNLOAD_TIMEOUT_SECONDS: 600,
  } as IndexerEnv;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GithubTarballClient.resolveHeadSha", () => {
  it("returns the commit sha on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { sha: "abc123" })));
    const client = new GithubTarballClient(config());

    await expect(client.resolveHeadSha("octocat/hello-world", "main", "token")).resolves.toBe("abc123");
  });

  it("throws non-retryable REPO_EMPTY when GitHub reports the repository has zero commits", async () => {
    // Real response captured from GitHub for a freshly created, unpushed repo.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { message: "Git Repository is empty.", documentation_url: "...", status: "409" }))
    );
    const client = new GithubTarballClient(config());

    const err = await client.resolveHeadSha("octocat/empty-repo", "main", "token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("REPO_EMPTY");
    expect((err as AppError).retryable).toBe(false);
  });

  it("throws GITHUB_ACCESS_DENIED on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { message: "Not Found" })));
    const client = new GithubTarballClient(config());

    const err = await client.resolveHeadSha("octocat/missing", "main", "token").catch((e: unknown) => e);
    expect((err as AppError).code).toBe("GITHUB_ACCESS_DENIED");
  });

  it("throws retryable SNAPSHOT_DOWNLOAD_FAILED for an unrecognized error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "Internal Server Error" })));
    const client = new GithubTarballClient(config());

    const err = await client.resolveHeadSha("octocat/hello-world", "main", "token").catch((e: unknown) => e);
    expect((err as AppError).code).toBe("SNAPSHOT_DOWNLOAD_FAILED");
    expect((err as AppError).retryable).toBe(true);
  });
});
