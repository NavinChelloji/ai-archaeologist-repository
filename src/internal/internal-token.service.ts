import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { APP_CONFIG } from "../config/config.module";
import type { IndexerEnv } from "../config/env";

/** The three deployables that can hold `INTERNAL_JWT_SECRET` and mint or accept this token. */
export type InternalServiceName = "api" | "indexer" | "ai";

const KNOWN_ISSUERS: [InternalServiceName, ...InternalServiceName[]] = ["api", "indexer", "ai"];

export interface InternalTokenClaims {
  iss: string;
  aud: InternalServiceName;
  sub: string;
  repoId?: string;
  scope: string[];
  jti: string;
}

export interface IssueInternalTokenInput {
  iss: InternalServiceName;
  aud: InternalServiceName;
  sub: string;
  repoId?: string;
  scope?: string[];
}

/**
 * Issues and verifies the internal service JWT from CODEBASE.md's
 * Authorization Model / API_GATEWAY_SERVICE_PLAN.md "Internal Service
 * Tokens": HS256, 60s TTL, `iss: api`, `aud: indexer|ai`, `sub: userId`,
 * `repoId` when repo-scoped, `scope`, and a `jti` per token. Ownership is
 * resolved once at `api`; `indexer` and `ai` only trust this token's
 * claims, they never re-check ownership.
 */
@Injectable()
export class InternalTokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: IndexerEnv) {}

  issue(input: IssueInternalTokenInput): string {
    const jti = randomUUID();
    const scope = input.scope ?? [];
    return jwt.sign({ repoId: input.repoId, scope, jti }, this.config.INTERNAL_JWT_SECRET, {
      expiresIn: "60s",
      issuer: input.iss,
      audience: input.aud,
      subject: input.sub,
    });
  }

  /**
   * `expectedAudience` is this deployable's own name. Per
   * API_GATEWAY_SERVICE_PLAN.md "Internal Service Tokens": "Downstream
   * services validate `iss`, `aud`, `exp`, and signature" — a token minted
   * for one service must not be replayable against another, even though all
   * three share `INTERNAL_JWT_SECRET`.
   */
  verify(token: string, expectedAudience: InternalServiceName): InternalTokenClaims {
    const payload = jwt.verify(token, this.config.INTERNAL_JWT_SECRET, {
      audience: expectedAudience,
      issuer: KNOWN_ISSUERS,
    }) as jwt.JwtPayload & {
      repoId?: string;
      scope?: string[];
      jti?: string;
    };
    return {
      iss: payload.iss ?? "",
      aud: payload.aud as InternalServiceName,
      sub: payload.sub ?? "",
      repoId: payload.repoId,
      scope: payload.scope ?? [],
      jti: payload.jti ?? "",
    };
  }
}
