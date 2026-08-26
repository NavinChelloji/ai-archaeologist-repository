import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { AstExtractionResult } from "../ast-extractor";
import type { ParseRequest, ParseResponse } from "./protocol";

export interface ParseTask {
  relativePath: string;
  language: string;
  content: string;
}

export interface ParseOutcome {
  relativePath: string;
  result: AstExtractionResult | null;
  /** Set when `result` is null — a parse error or a timed-out (and therefore skipped) file. Never fatal to the stage. */
  error: string | null;
}

/** What `ParserService` actually depends on — lets tests inject a stub instead of spinning up real worker threads. */
export interface AstParserPool {
  parse(task: ParseTask): Promise<ParseOutcome>;
  destroy(): Promise<void>;
}

export const PARSER_WORKER_POOL = Symbol("PARSER_WORKER_POOL");

interface QueueItem {
  task: ParseTask;
  resolve: (outcome: ParseOutcome) => void;
}

interface InFlight {
  id: number;
  task: ParseTask;
  resolve: (outcome: ParseOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bounded-concurrency dispatcher over `node:worker_threads`
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parsing Approach": worker threads,
 * `PARSER_CONCURRENCY`, and a per-file timeout after which "a pathological
 * file is skipped and recorded, not allowed to kill the stage"). A timed-out
 * worker is terminated and replaced rather than reused, since the TS
 * compiler's parse is synchronous CPU work a worker can't self-interrupt.
 */
export class ParserWorkerPool implements AstParserPool {
  private readonly all = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<Worker, InFlight>();
  private nextId = 0;
  private destroyed = false;

  constructor(
    private readonly concurrency: number,
    private readonly fileTimeoutMs: number,
    private readonly scriptPath: string = join(__dirname, "ts-worker.js")
  ) {
    for (let i = 0; i < concurrency; i += 1) {
      this.idle.push(this.spawnWorker());
    }
  }

  parse(task: ParseTask): Promise<ParseOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.pump();
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const inFlight of this.inFlight.values()) {
      clearTimeout(inFlight.timer);
    }
    await Promise.all([...this.all].map((worker) => worker.terminate()));
  }

  private spawnWorker(): Worker {
    const worker = new Worker(this.scriptPath);
    worker.on("message", (message: ParseResponse) => this.handleMessage(worker, message));
    worker.on("error", (err: Error) => this.handleWorkerError(worker, err));
    this.all.add(worker);
    return worker;
  }

  private pump(): void {
    while (!this.destroyed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const item = this.queue.shift()!;
      this.dispatch(worker, item);
    }
  }

  private dispatch(worker: Worker, item: QueueItem): void {
    const id = this.nextId;
    this.nextId += 1;

    const timer = setTimeout(() => {
      const inFlight = this.inFlight.get(worker);
      if (!inFlight || inFlight.id !== id) return;
      this.inFlight.delete(worker);
      inFlight.resolve({ relativePath: item.task.relativePath, result: null, error: `parse timed out after ${this.fileTimeoutMs}ms` });
      this.replaceWorker(worker);
    }, this.fileTimeoutMs);

    this.inFlight.set(worker, { id, task: item.task, resolve: item.resolve, timer });
    const request: ParseRequest = { id, language: item.task.language, relativePath: item.task.relativePath, content: item.task.content };
    worker.postMessage(request);
  }

  private handleMessage(worker: Worker, message: ParseResponse): void {
    const inFlight = this.inFlight.get(worker);
    if (!inFlight || inFlight.id !== message.id) return; // stale reply for an already-timed-out task
    clearTimeout(inFlight.timer);
    this.inFlight.delete(worker);
    inFlight.resolve(
      message.ok
        ? { relativePath: inFlight.task.relativePath, result: message.result, error: null }
        : { relativePath: inFlight.task.relativePath, result: null, error: message.error }
    );
    this.releaseWorker(worker);
  }

  private handleWorkerError(worker: Worker, err: Error): void {
    const inFlight = this.inFlight.get(worker);
    if (inFlight) {
      clearTimeout(inFlight.timer);
      this.inFlight.delete(worker);
      inFlight.resolve({ relativePath: inFlight.task.relativePath, result: null, error: err.message });
    }
    this.replaceWorker(worker);
  }

  private releaseWorker(worker: Worker): void {
    if (this.destroyed) return;
    this.idle.push(worker);
    this.pump();
  }

  private replaceWorker(worker: Worker): void {
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex !== -1) this.idle.splice(idleIndex, 1);
    this.all.delete(worker);
    void worker.terminate();
    if (this.destroyed) return;
    this.idle.push(this.spawnWorker());
    this.pump();
  }
}
