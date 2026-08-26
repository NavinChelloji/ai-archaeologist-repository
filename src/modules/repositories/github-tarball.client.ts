import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Inject, Injectable } from "@nestjs/common";
import { AppError } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";

const USER_AGENT = "ai-code-archaeologist";
const BYTES_PER_MB = 1024 * 1024;

export interface DownloadTarballInput {
  fullName: string;
  commitSha: string;
  token: string;
  destPath: string;
}

export interface DownloadTarballResult {
  sizeBytes: number;
}

/**
 * Resolves a ref to a commit SHA and streams the GitHub tarball to disk
 * (GITHUB_CONNECTOR_SERVICE_PLAN.md "GitHub Access": tarball endpoint over
 * `git clone`, aborting the moment `MAX_REPOSITORY_ARCHIVE_MB` is exceeded
 * rather than downloading first and checking after).
 */
@Injectable()
export class GithubTarballClient {
  constructor(@Inject(APP_CONFIG) private readonly config: IndexerEnv) {}

  async resolveHeadSha(fullName: string, ref: string, token: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.config.GITHUB_API_BASE_URL}/repos/${fullName}/commits/${ref}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
        },
      });
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Could not reach GitHub.");
    }

    if (response.status === 403 || response.status === 429) {
      this.throwRateLimitOrAccessDenied(response);
    }
    if (response.status === 404) {
      throw new AppError("GITHUB_ACCESS_DENIED", "This repository or ref was not found or is not accessible.");
    }
    if (response.status === 409) {
      // GitHub's commits endpoint returns 409 for a repo with zero commits — a
      // permanent condition, not a transient one, so this must not be tagged
      // retryable like the generic SNAPSHOT_DOWNLOAD_FAILED fallback below.
      throw new AppError("REPO_EMPTY", "This GitHub repository is empty. Push at least one commit before importing it.");
    }
    if (!response.ok) {
      throw new AppError("SNAPSHOT_DOWNLOAD_FAILED", "GitHub returned an unexpected error resolving the commit.");
    }

    const body = (await response.json()) as { sha: string };
    return body.sha;
  }

  async downloadTarball(input: DownloadTarballInput): Promise<DownloadTarballResult> {
    let response: Response;
    try {
      response = await fetch(`${this.config.GITHUB_API_BASE_URL}/repos/${input.fullName}/tarball/${input.commitSha}`, {
        headers: {
          authorization: `Bearer ${input.token}`,
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(this.config.DOWNLOAD_TIMEOUT_SECONDS * 1000),
      });
    } catch {
      throw new AppError("SNAPSHOT_DOWNLOAD_FAILED", "Could not reach GitHub to download the repository archive.");
    }

    if (response.status === 403 || response.status === 429) {
      this.throwRateLimitOrAccessDenied(response);
    }
    if (!response.ok || !response.body) {
      throw new AppError("SNAPSHOT_DOWNLOAD_FAILED", "GitHub returned an unexpected error downloading the archive.");
    }

    const maxBytes = this.config.MAX_REPOSITORY_ARCHIVE_MB * BYTES_PER_MB;
    const nodeStream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);

    let downloaded = 0;
    nodeStream.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
      if (downloaded > maxBytes) {
        nodeStream.destroy(
          new AppError("REPO_TOO_LARGE", `This repository is above the ${this.config.MAX_REPOSITORY_ARCHIVE_MB} MB import limit.`)
        );
      }
    });

    try {
      await pipeline(nodeStream, createWriteStream(input.destPath));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("SNAPSHOT_DOWNLOAD_FAILED", "The repository archive download failed partway through.", { cause: err });
    }

    return { sizeBytes: downloaded };
  }

  private throwRateLimitOrAccessDenied(response: Response): never {
    const retryAfterHeader = response.headers.get("retry-after");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const isRateLimit = response.status === 429 || remaining === "0";
    if (isRateLimit) {
      throw new AppError("GITHUB_RATE_LIMITED", "GitHub rate limit reached. Please try again shortly.", {
        details: retryAfterHeader ? { retryAfterSeconds: Number(retryAfterHeader) } : undefined,
      });
    }
    throw new AppError("GITHUB_ACCESS_DENIED", "GitHub declined access to this repository.");
  }
}
