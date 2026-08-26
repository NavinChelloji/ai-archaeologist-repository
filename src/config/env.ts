import { z } from "zod";
import { backendBaseEnvShape, booleanFromString, loadEnv, portSchema, urlSchema } from "@aca/config";

const IndexerEnvSchema = z.object({
  ...backendBaseEnvShape,
  PORT: portSchema.default(3100),
  INDEXER_DATABASE_URL: urlSchema,

  API_SERVICE_URL: urlSchema,
  GITHUB_API_BASE_URL: urlSchema.default("https://api.github.com"),

  // Object storage (GITHUB_CONNECTOR_SERVICE_PLAN.md calls this
  // S3_BUCKET_SNAPSHOTS; the checked-in infra from Stage 1 — docker-compose,
  // root .env.example — already names it S3_BUCKET, so that's what's used
  // here to stay consistent with what's actually provisioned).
  S3_ENDPOINT: urlSchema,
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),

  // SCOPE_LIMITS.md
  MAX_REPOSITORY_ARCHIVE_MB: z.coerce.number().int().positive().default(500),
  MAX_REPOSITORIES_PER_USER: z.coerce.number().int().positive().default(10),
  MAX_EXTRACTED_SIZE_MB: z.coerce.number().int().positive().default(2048),
  MAX_FILES_PER_REPO: z.coerce.number().int().positive().default(20000),
  MAX_FILE_SIZE_KB: z.coerce.number().int().positive().default(512),
  MAX_DIRECTORY_DEPTH: z.coerce.number().int().positive().default(32),
  SNAPSHOT_RETENTION_COUNT: z.coerce.number().int().positive().default(2),
  TEMP_WORK_DIR: z.string().default("/tmp/aca"),
  DOWNLOAD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),

  // REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parsing Approach"
  PARSER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PARSER_FILE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  PARSER_BATCH_SIZE: z.coerce.number().int().positive().default(500),

  // GRAPH_SERVICE_PLAN.md
  GRAPH_QUERY_MAX_NODES: z.coerce.number().int().positive().default(1500),
  GRAPH_NEIGHBOR_MAX_DEPTH: z.coerce.number().int().positive().default(3),
  GRAPH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  GRAPH_BUILD_BATCH_SIZE: z.coerce.number().int().positive().default(2000),

  // JOB_ORCHESTRATOR_SERVICE_PLAN.md / SCOPE_LIMITS.md "Processing Limits"
  JOB_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_RETRY_COUNT: z.coerce.number().int().positive().default(3),
  RETRY_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(30),
  STAGE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  STALLED_JOB_SWEEP_SECONDS: z.coerce.number().int().positive().default(60),
  JOB_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type IndexerEnv = z.infer<typeof IndexerEnvSchema>;

export function loadIndexerEnv(): IndexerEnv {
  return loadEnv(IndexerEnvSchema);
}
