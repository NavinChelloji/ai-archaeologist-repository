import { Inject, Injectable } from "@nestjs/common";
import { AppError, InternalGithubTokenResponseSchema } from "@aca/contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { InternalTokenService } from "../../internal/internal-token.service";

const USER_AGENT = "ai-code-archaeologist";

/**
 * Requests a GitHub token for one user from `api`, just-in-time
 * (GITHUB_CONNECTOR_SERVICE_PLAN.md "It does not store GitHub tokens. It
 * requests one from `api` per job and holds it in memory for the duration
 * of a single [call]"). Never persisted, never logged.
 */
@Injectable()
export class GithubTokenClient {
  constructor(
    private readonly internalTokens: InternalTokenService,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv
  ) {}

  async fetchToken(userId: string): Promise<string> {
    const internalToken = this.internalTokens.issue({
      iss: "indexer",
      aud: "api",
      sub: userId,
      scope: ["github:token"],
    });

    let response: Response;
    try {
      response = await fetch(`${this.config.API_SERVICE_URL}/internal/github/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${internalToken}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ userId }),
      });
    } catch {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Could not reach the authentication service.");
    }

    if (response.status === 403) {
      throw new AppError("GITHUB_RECONNECT_REQUIRED", "GitHub is not connected for this account.");
    }
    if (!response.ok) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Could not obtain a GitHub token for this account.");
    }

    const parsed = InternalGithubTokenResponseSchema.parse(await response.json());
    return parsed.token;
  }
}
