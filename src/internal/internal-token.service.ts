import { Inject, Injectable } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { APP_CONFIG } from "../config/config.module";
import type { IndexerEnv } from "../config/env";

export interface InternalTokenClaims {
  iss: string;
  aud: "indexer" | "ai";
  sub: string;
  repoId?: string;
}

/**
 * Issues and verifies the internal service JWT from CODEBASE.md's
 * Authorization Model: HS256, 60s TTL, `iss: api`, `aud: indexer|ai`,
 * `sub: userId`. Ownership is resolved once at `api`; `indexer` and `ai`
 * only trust this token's claims, they never re-check ownership.
 */
@Injectable()
export class InternalTokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: IndexerEnv) {}

  issue(claims: InternalTokenClaims): string {
    return jwt.sign(claims, this.config.INTERNAL_JWT_SECRET, {
      expiresIn: "60s",
      issuer: claims.iss,
      audience: claims.aud,
      subject: claims.sub,
    });
  }

  verify(token: string): InternalTokenClaims {
    return jwt.verify(token, this.config.INTERNAL_JWT_SECRET) as unknown as InternalTokenClaims;
  }
}
