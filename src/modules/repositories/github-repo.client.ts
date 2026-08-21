import { Inject, Injectable } from "@nestjs/common";
import { AppError } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";

export interface GithubRepoDetails {
  providerRepoId: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  primaryLanguage: string | null;
  sizeKb: number;
}

const USER_AGENT = "ai-code-archaeologist";

/**
 * Fetches authoritative repository metadata straight from GitHub using a
 * just-in-time token, rather than trusting whatever `api` forwards
 * (RULES.md #14 "Verify the user has access to the selected repository
 * before importing").
 */
@Injectable()
export class GithubRepoClient {
  constructor(@Inject(APP_CONFIG) private readonly config: IndexerEnv) {}

  async fetchById(providerRepoId: string, token: string): Promise<GithubRepoDetails> {
    let response: Response;
    try {
      response = await fetch(`${this.config.GITHUB_API_BASE_URL}/repositories/${providerRepoId}`, {
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
    if (response.status === 404) {
      throw new AppError("GITHUB_ACCESS_DENIED", "This repository was not found or is not accessible.");
    }
    if (!response.ok) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "GitHub returned an unexpected error.");
    }

    const body = (await response.json()) as {
      id: number;
      full_name: string;
      default_branch: string;
      private: boolean;
      language: string | null;
      size: number;
    };

    return {
      providerRepoId: String(body.id),
      fullName: body.full_name,
      defaultBranch: body.default_branch,
      isPrivate: body.private,
      primaryLanguage: body.language,
      sizeKb: body.size,
    };
  }
}
