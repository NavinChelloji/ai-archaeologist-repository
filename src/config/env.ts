import { z } from "zod";
import { backendBaseEnvShape, loadEnv, portSchema, urlSchema } from "@aca/config";

const IndexerEnvSchema = z.object({
  ...backendBaseEnvShape,
  PORT: portSchema.default(3100),
  INDEXER_DATABASE_URL: urlSchema,

  API_SERVICE_URL: urlSchema,
  GITHUB_API_BASE_URL: urlSchema.default("https://api.github.com"),

  // SCOPE_LIMITS.md
  MAX_REPOSITORY_ARCHIVE_MB: z.coerce.number().int().positive().default(500),
  MAX_REPOSITORIES_PER_USER: z.coerce.number().int().positive().default(10),

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
