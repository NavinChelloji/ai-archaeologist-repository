import { z } from "zod";
import { backendBaseEnvShape, loadEnv, portSchema, urlSchema } from "@aca/config";

const IndexerEnvSchema = z.object({
  ...backendBaseEnvShape,
  PORT: portSchema.default(3100),
  INDEXER_DATABASE_URL: urlSchema,
});

export type IndexerEnv = z.infer<typeof IndexerEnvSchema>;

export function loadIndexerEnv(): IndexerEnv {
  return loadEnv(IndexerEnvSchema);
}
