import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { HealthService, type ReadyResult } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Process is up and accepting requests — no dependency checks. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Dependencies are actually reachable, not just that the process exists. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: FastifyReply): Promise<ReadyResult> {
    const result = await this.health.checkReady();
    res.status(result.status === "ok" ? 200 : 503);
    return result;
  }
}
