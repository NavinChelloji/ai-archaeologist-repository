import "reflect-metadata";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { HttpMetrics } from "@aca/metrics";
import { AppModule } from "./app.module";
import { loadIndexerEnv } from "./config/env";
import { HTTP_METRICS } from "./shared/metrics/metrics.module";

config();

const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * `indexer` is CPU-heavy and bursty (CODEBASE.md "Why these boundaries"),
 * so the same build runs as either an HTTP instance or a queue worker —
 * "same build, different startup command, different scaling policy"
 * (WORKSPACE_AND_PACKAGE_STRATEGY.md). Job subscriptions in SystemModule
 * and future pipeline modules start in both roles; only the HTTP listener
 * is role-gated.
 */
const isWorker = process.argv.includes("--role=worker");

async function bootstrap(): Promise<void> {
  if (isWorker) {
    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    app.enableShutdownHooks();
    // eslint-disable-next-line no-console
    console.log("indexer worker started (no HTTP listener)");
    return;
  }

  const env = loadIndexerEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", async (request, reply) => {
    const header = request.headers[CORRELATION_ID_HEADER];
    request.correlationId = typeof header === "string" && header.length > 0 ? header : randomUUID();
    reply.header(CORRELATION_ID_HEADER, request.correlationId);
  });

  const httpMetrics = app.get<HttpMetrics>(HTTP_METRICS);
  fastify.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? request.url;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpMetrics.requestsTotal.inc(labels);
    httpMetrics.requestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.enableShutdownHooks();

  await app.listen(env.PORT, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`indexer listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error("indexer failed to start", err);
  process.exit(1);
});
