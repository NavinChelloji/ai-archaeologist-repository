import type { AstExtractionResult } from "../ast-extractor";

/** Message shapes exchanged between `worker-pool.ts` (main thread) and `ts-worker.ts` (worker thread). */

export interface ParseRequest {
  id: number;
  language: string;
  relativePath: string;
  content: string;
}

export type ParseResponse =
  | { id: number; ok: true; result: AstExtractionResult }
  | { id: number; ok: false; error: string };
