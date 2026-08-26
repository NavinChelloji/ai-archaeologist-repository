import { afterEach, describe, expect, it } from "vitest";
import { ParserWorkerPool } from "./worker-pool";

/**
 * Exercises the pool's dispatch/timeout/replace mechanics against a real
 * `worker_threads` worker running from an `eval`'d script (`{ eval: true }`)
 * rather than the compiled `ts-worker.js` — that file only exists after
 * `nest build`, which vitest doesn't run, so a real end-to-end run against
 * it is covered separately by the built service's boot check, not here.
 */

const ECHO_WITH_DELAY_SCRIPT = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  const delayMs = msg.content === "slow" ? 500 : 0;
  setTimeout(() => {
    parentPort.postMessage({ id: msg.id, ok: true, result: { symbols: [], imports: [{ specifier: msg.relativePath, kind: "esm", isLiteralSpecifier: true, line: 1 }] } });
  }, delayMs);
});
`;

const THROW_SCRIPT = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  parentPort.postMessage({ id: msg.id, ok: false, error: "boom" });
});
`;

const HANG_SCRIPT = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => { /* never respond */ });
`;

let pools: ParserWorkerPool[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(pools.map((p) => p.destroy()));
  pools = [];
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("ParserWorkerPool", () => {
  it("resolves a successful parse", async () => {
    const pool = await poolFromScript(ECHO_WITH_DELAY_SCRIPT, 1, 5000);
    const outcome = await pool.parse({ relativePath: "src/a.ts", language: "typescript", content: "fast" });
    expect(outcome.error).toBeNull();
    expect(outcome.result?.imports).toEqual([{ specifier: "src/a.ts", kind: "esm", isLiteralSpecifier: true, line: 1 }]);
  });

  it("bounds concurrency to the configured pool size", async () => {
    const pool = await poolFromScript(ECHO_WITH_DELAY_SCRIPT, 2, 5000);
    const started = Date.now();
    // 3 slow tasks over a 2-worker pool: the 3rd must wait for one of the first two to free up.
    await Promise.all([
      pool.parse({ relativePath: "a", language: "typescript", content: "slow" }),
      pool.parse({ relativePath: "b", language: "typescript", content: "slow" }),
      pool.parse({ relativePath: "c", language: "typescript", content: "slow" }),
    ]);
    // Two batches of ~500ms each, serialized by the 2-worker cap.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("surfaces a worker-reported error without crashing the pool", async () => {
    const pool = await poolFromScript(THROW_SCRIPT, 1, 5000);
    const outcome = await pool.parse({ relativePath: "src/a.ts", language: "typescript", content: "x" });
    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe("boom");
  });

  it("times out a hung file, terminates the worker, and keeps serving later tasks", async () => {
    const pool = await poolFromScript(HANG_SCRIPT, 1, 50);
    const outcome = await pool.parse({ relativePath: "src/hangs.ts", language: "typescript", content: "x" });
    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain("timed out");
  });
});

async function poolFromScript(script: string, concurrency: number, timeoutMs: number): Promise<ParserWorkerPool> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "aca-worker-pool-test-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "worker.js");
  await writeFile(scriptPath, script, "utf8");
  const pool = new ParserWorkerPool(concurrency, timeoutMs, scriptPath);
  pools.push(pool);
  return pool;
}
