import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { loadIndexerEnv } from "./config/env";

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

  app.enableShutdownHooks();

  await app.listen(env.PORT, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`indexer listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error("indexer failed to start", err);
  process.exit(1);
});
