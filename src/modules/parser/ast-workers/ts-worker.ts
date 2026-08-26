import { parentPort } from "node:worker_threads";
import { LANGUAGE_PARSERS } from "../ast-extractor";
import type { ParseRequest, ParseResponse } from "./protocol";

/**
 * Worker-thread entry point (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parsing
 * Approach": "in worker threads, so parsing never blocks the event loop").
 * Compiled to `dist/modules/parser/ast-workers/ts-worker.js` by `nest build`
 * alongside the rest of `src/`, and loaded from there by `worker-pool.ts`
 * via a `__dirname`-relative path so it resolves the same way in dev
 * (`nest start --watch`, which also runs from `dist/`) and in production.
 */
if (!parentPort) {
  throw new Error("ts-worker.ts must be run inside a worker thread");
}

parentPort.on("message", (request: ParseRequest) => {
  const port = parentPort!;
  const parser = LANGUAGE_PARSERS.get(request.language);
  if (!parser) {
    port.postMessage({ id: request.id, ok: false, error: `no parser registered for language "${request.language}"` } satisfies ParseResponse);
    return;
  }

  try {
    const result = parser.parse(request.relativePath, request.content);
    port.postMessage({ id: request.id, ok: true, result } satisfies ParseResponse);
  } catch (err) {
    port.postMessage({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ParseResponse);
  }
});
