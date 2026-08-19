import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { InternalTokenService, type InternalTokenClaims } from "./internal-token.service";

export type RequestWithInternalClaims = FastifyRequest & { internalClaims?: InternalTokenClaims };

const BEARER_PREFIX = "Bearer ";

/**
 * Protects every `/internal/*` route (RULES.md #12: "require a valid
 * internal token and must not be routed from the public ingress"). Never
 * put this guard's routes behind the public API gateway path.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly tokens: InternalTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithInternalClaims>();
    const header = request.headers["authorization"];

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException({ code: "INTERNAL_TOKEN_INVALID" });
    }

    try {
      request.internalClaims = this.tokens.verify(header.slice(BEARER_PREFIX.length));
      return true;
    } catch {
      throw new UnauthorizedException({ code: "INTERNAL_TOKEN_INVALID" });
    }
  }
}
