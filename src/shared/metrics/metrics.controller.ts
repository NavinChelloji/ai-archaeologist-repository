import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Registry } from "@aca/metrics";
import { METRICS_REGISTRY } from "./metrics.tokens";

/** Unauthenticated, like `/health/*` — Prometheus scrapes this over the internal network, not through the public ingress. */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  async getMetrics(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header("content-type", this.registry.contentType);
    return this.registry.metrics();
  }
}
