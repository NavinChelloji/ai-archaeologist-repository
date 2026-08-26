import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, type JobStage } from "@aca/contracts";
import type { IndexerEnv } from "../../config/env";
import type { RepositoriesService } from "../repositories/repositories.service";
import type { JobStageEventRow, RecordEventInput } from "./job-stage-events.repository";
import { PipelineService } from "./pipeline.service";
import type { CreateJobInput, ProcessingJobRow } from "./processing-jobs.repository";
import type { ProgressPublisherService } from "./progress-publisher.service";

const USER_ID = "123e4567-e89b-12d3-a456-426614174000";
const REPO_ID = "123e4567-e89b-12d3-a456-426614174001";
const CORRELATION_ID = "123e4567-e89b-12d3-a456-426614174002";

function fakeJobsRepo() {
  const jobs = new Map<string, ProcessingJobRow>();

  return {
    jobs,
    async create(input: CreateJobInput): Promise<ProcessingJobRow | null> {
      const active = [...jobs.values()].find(
        (j) => j.repo_id === input.repoId && (j.status === "queued" || j.status === "running")
      );
      if (active) return null;

      const row: ProcessingJobRow = {
        id: input.id,
        repo_id: input.repoId,
        snapshot_id: null,
        requested_by: input.requestedBy,
        status: "queued",
        current_stage: "queued",
        progress_percent: 0,
        retry_count: 0,
        error_code: null,
        error_message: null,
        correlation_id: input.correlationId,
        started_at: new Date(),
        completed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      jobs.set(row.id, row);
      return row;
    },
    async findById(jobId: string) {
      return jobs.get(jobId) ?? null;
    },
    async findActiveByRepoId(repoId: string) {
      return [...jobs.values()].find((j) => j.repo_id === repoId && (j.status === "queued" || j.status === "running")) ?? null;
    },
    async findLatestByRepoId(repoId: string) {
      const rows = [...jobs.values()]
        .filter((j) => j.repo_id === repoId)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return rows[0] ?? null;
    },
    async advanceStage(jobId: string, input: { stage: JobStage; status: string; progressPercent: number; snapshotId?: string | null }) {
      const row = jobs.get(jobId)!;
      row.current_stage = input.stage;
      row.status = input.status as ProcessingJobRow["status"];
      row.progress_percent = input.progressPercent;
      if (input.snapshotId) row.snapshot_id = input.snapshotId;
      if (input.status === "completed" || input.status === "failed" || input.status === "cancelled") {
        row.completed_at = new Date();
      }
      row.updated_at = new Date();
      return row;
    },
    async updateProgress(jobId: string, progressPercent: number) {
      const row = jobs.get(jobId)!;
      row.progress_percent = progressPercent;
      row.updated_at = new Date();
    },
    async incrementRetry(jobId: string) {
      const row = jobs.get(jobId)!;
      row.retry_count += 1;
      row.updated_at = new Date();
      return row;
    },
    async resetRetryCount(jobId: string) {
      const row = jobs.get(jobId)!;
      row.retry_count = 0;
    },
    async markFailed(jobId: string, errorCode: string, errorMessage: string) {
      const row = jobs.get(jobId)!;
      row.status = "failed";
      row.current_stage = "failed";
      row.error_code = errorCode;
      row.error_message = errorMessage;
      row.completed_at = new Date();
      return row;
    },
    async markCancelled(jobId: string) {
      const row = jobs.get(jobId)!;
      row.status = "cancelled";
      row.current_stage = "cancelled";
      row.completed_at = new Date();
      return row;
    },
    async resumeIntoStage(jobId: string, stage: JobStage, progressPercent: number) {
      const row = jobs.get(jobId)!;
      row.status = "running";
      row.current_stage = stage;
      row.progress_percent = progressPercent;
      row.error_code = null;
      row.error_message = null;
      row.completed_at = null;
      return row;
    },
    async findStalled() {
      return [];
    },
  };
}

function fakeStageEventsRepo() {
  const events: JobStageEventRow[] = [];

  return {
    events,
    async record(input: RecordEventInput): Promise<JobStageEventRow> {
      const row: JobStageEventRow = {
        id: randomUUID(),
        job_id: input.jobId,
        stage: input.stage,
        event_type: input.eventType,
        items_processed: input.itemsProcessed ?? null,
        total_items: input.totalItems ?? null,
        duration_ms: input.durationMs ?? null,
        payload: input.payload,
        created_at: new Date(),
      };
      events.push(row);
      return row;
    },
    async findLatestByEventType(jobId: string, eventType: string) {
      const matches = events.filter((e) => e.job_id === jobId && e.event_type === eventType);
      return matches[matches.length - 1] ?? null;
    },
    async findLatestFailure(jobId: string) {
      const matches = events.filter((e) => e.job_id === jobId && e.event_type === "repo.stage.failed");
      return matches[matches.length - 1] ?? null;
    },
    async listForJob(jobId: string) {
      return events.filter((e) => e.job_id === jobId);
    },
  };
}

function buildHarness(configOverrides: Partial<IndexerEnv> = {}) {
  const jobsRepo = fakeJobsRepo();
  const stageEventsRepo = fakeStageEventsRepo();
  const send = vi.fn().mockResolvedValue("queue-job-id");
  const boss = { send } as unknown as PgBoss;
  const publish = vi.fn().mockResolvedValue(undefined);
  const progress = { publish } as unknown as ProgressPublisherService;
  const activateSnapshot = vi.fn().mockResolvedValue(undefined);
  const getById = vi.fn().mockResolvedValue({ repoId: REPO_ID, activeSnapshotId: null });
  const repositories = { activateSnapshot, getById } as unknown as RepositoriesService;
  const config = { MAX_RETRY_COUNT: 3, RETRY_BACKOFF_BASE_SECONDS: 30, STAGE_TIMEOUT_SECONDS: 1800, ...configOverrides } as unknown as IndexerEnv;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new PipelineService(boss, config, logger, jobsRepo as never, stageEventsRepo as never, progress, repositories);

  return { service, jobsRepo, stageEventsRepo, send, publish, activateSnapshot, getById };
}

function envelope<T extends string>(eventType: T, payload: unknown, extra: { causationId?: string; snapshotId?: string } = {}) {
  return buildEnvelope({
    eventType: eventType as never,
    payload: payload as never,
    correlationId: CORRELATION_ID,
    userId: USER_ID,
    repoId: REPO_ID,
    ...extra,
  }) as never;
}

const importPayload = {
  provider: "github" as const,
  providerRepoId: "789",
  fullName: "owner/repo",
  defaultBranch: "main",
  isPrivate: false,
  ref: null,
  reindex: false,
};

function stageProgress(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stage: "snapshotting",
    batchIndex: 0,
    batchCount: 1,
    itemsProcessed: 1,
    totalItems: 1,
    durationMs: 5,
    ...overrides,
  };
}

describe("PipelineService", () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("creates a job and enters snapshotting on repo.import.requested", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));

    const job = [...harness.jobsRepo.jobs.values()][0]!;
    expect(job.status).toBe("running");
    expect(job.current_stage).toBe("snapshotting");
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({ stage: "snapshotting", status: "running" }));
  });

  it("lets exactly one job survive a concurrent import (partial unique index semantics)", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));

    expect(harness.jobsRepo.jobs.size).toBe(1);
  });

  it("does not advance the stage on a non-terminal batch, only progress", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    await harness.service.handleSnapshotCreated(
      envelope("repo.snapshot.created", {
        commitSha: "abc123",
        ref: "main",
        archiveKey: "key",
        sizeBytes: 100,
        reused: false,
        ...stageProgress({ batchIndex: 0, batchCount: 3, itemsProcessed: 1, totalItems: 3 }),
      })
    );

    expect(job.current_stage).toBe("snapshotting");
    expect(job.progress_percent).toBeGreaterThan(0);
    expect(job.progress_percent).toBeLessThan(10);
  });

  it("advances snapshotting -> extracting on the terminal batch and records the snapshot id", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    const snapshotId = "123e4567-e89b-12d3-a456-426614174099";

    await harness.service.handleSnapshotCreated(
      envelope(
        "repo.snapshot.created",
        { commitSha: "abc123", ref: "main", archiveKey: "key", sizeBytes: 100, reused: false, ...stageProgress() },
        { snapshotId }
      )
    );

    expect(job.current_stage).toBe("extracting");
    expect(job.snapshot_id).toBe(snapshotId);
  });

  it("ignores a duplicate terminal event once the job has already moved past that stage", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    const snapshotEnvelope = envelope("repo.snapshot.created", {
      commitSha: "abc123",
      ref: "main",
      archiveKey: "key",
      sizeBytes: 100,
      reused: false,
      ...stageProgress(),
    });

    await harness.service.handleSnapshotCreated(snapshotEnvelope);
    expect(job.current_stage).toBe("extracting");

    // Redelivery of the same terminal event after the job has moved on.
    await harness.service.handleSnapshotCreated(snapshotEnvelope);
    expect(job.current_stage).toBe("extracting");
  });

  it("advances parsing -> graphing only once both symbols and dependencies have terminated, regardless of order", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    job.current_stage = "parsing";
    job.status = "running";

    await harness.service.handleDependenciesExtracted(
      envelope("repo.dependencies.extracted", {
        commitSha: "abc123",
        edgeCount: 3,
        languageSupported: true,
        byResolution: { resolved: 3, external: 0, unresolved: 0, dynamic_unresolvable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );
    expect(job.current_stage).toBe("parsing");

    await harness.service.handleSymbolsExtracted(
      envelope("repo.symbols.extracted", {
        commitSha: "abc123",
        symbolCount: 5,
        languageSupported: true,
        byType: { class: 1, interface: 0, function: 4, method: 0, type: 0, enum: 0, variable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );

    expect(job.current_stage).toBe("graphing");
  });

  it("records parsing terminals that arrive before the job has even reached extracting, without dropping them or jumping stages", async () => {
    // Regression test: Pipeline and the Graph module each consume repo.symbols.extracted /
    // repo.dependencies.extracted independently (@aca/queue fan-out), so pg-boss gives no guarantee
    // these arrive at Pipeline *after* repo.files.indexed has been processed and advanced the job to
    // "parsing" — they can legitimately arrive while the job is still "snapshotting" or "extracting".
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    expect(job.current_stage).toBe("snapshotting");

    await harness.service.handleDependenciesExtracted(
      envelope("repo.dependencies.extracted", {
        commitSha: "abc123",
        edgeCount: 3,
        languageSupported: true,
        byResolution: { resolved: 3, external: 0, unresolved: 0, dynamic_unresolvable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );
    await harness.service.handleSymbolsExtracted(
      envelope("repo.symbols.extracted", {
        commitSha: "abc123",
        symbolCount: 5,
        languageSupported: true,
        byType: { class: 1, interface: 0, function: 4, method: 0, type: 0, enum: 0, variable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );

    // Neither event was dropped...
    expect(harness.stageEventsRepo.events.some((e) => e.event_type === "repo.dependencies.extracted")).toBe(true);
    expect(harness.stageEventsRepo.events.some((e) => e.event_type === "repo.symbols.extracted")).toBe(true);
    // ...but the job did not jump straight to "graphing" from "snapshotting".
    expect(job.current_stage).toBe("snapshotting");

    // The normal snapshotting -> extracting -> parsing chain now runs...
    const snapshotId = "123e4567-e89b-12d3-a456-426614174099";
    await harness.service.handleSnapshotCreated(
      envelope(
        "repo.snapshot.created",
        { commitSha: "abc123", ref: "main", archiveKey: "key", sizeBytes: 100, reused: false, ...stageProgress() },
        { snapshotId }
      )
    );
    expect(job.current_stage).toBe("extracting");

    await harness.service.handleFilesIndexed(
      envelope("repo.files.indexed", {
        commitSha: "abc123",
        manifestKey: "manifest.json",
        fileCount: 10,
        skippedCount: 0,
        skippedReasons: { ignored: 0, binary: 0, too_large: 0, excluded_secret: 0, generated: 0 },
        languages: {},
        ...stageProgress({ stage: "extracting" }),
      })
    );

    // ...and lands directly on "graphing", since both parsing terminals were already recorded.
    expect(job.current_stage).toBe("graphing");
  });

  it("cascades graphing -> embedding when repo.graph.built arrived before the job reached graphing", async () => {
    // Same class of race as above: the Graph module builds independently of Pipeline and may publish
    // repo.graph.built before Pipeline's own parsing-terminal handling has advanced the job to "graphing".
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    job.current_stage = "parsing";
    job.status = "running";

    await harness.stageEventsRepo.record({
      jobId: job.id,
      stage: "extracting",
      eventType: "repo.files.indexed",
      payload: { manifestKey: "manifest.json", fileCount: 10 },
    });

    await harness.service.handleGraphBuilt(
      envelope("repo.graph.built", {
        commitSha: "abc123",
        graphs: { folder: { nodes: 1, edges: 0 }, dependency: { nodes: 1, edges: 0 }, symbol: { nodes: 1, edges: 0 } },
        ...stageProgress({ stage: "graphing" }),
      })
    );

    // Recorded, but not acted on yet — the job is still "parsing", not "graphing".
    expect(job.current_stage).toBe("parsing");
    expect(harness.send).not.toHaveBeenCalledWith("repo.index.requested", expect.anything(), expect.anything());

    await harness.service.handleDependenciesExtracted(
      envelope("repo.dependencies.extracted", {
        commitSha: "abc123",
        edgeCount: 3,
        languageSupported: true,
        byResolution: { resolved: 3, external: 0, unresolved: 0, dynamic_unresolvable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );
    await harness.service.handleSymbolsExtracted(
      envelope("repo.symbols.extracted", {
        commitSha: "abc123",
        symbolCount: 5,
        languageSupported: true,
        byType: { class: 1, interface: 0, function: 4, method: 0, type: 0, enum: 0, variable: 0 },
        ...stageProgress({ stage: "parsing" }),
      })
    );

    // Reaching "graphing" now immediately cascades into "embedding" since repo.graph.built was already recorded.
    expect(job.current_stage).toBe("embedding");
    expect(harness.send).toHaveBeenCalledWith(
      "repo.index.requested",
      expect.objectContaining({ payload: expect.objectContaining({ manifestKey: "manifest.json" }) }),
      {}
    );
  });

  it("requests embeddings from ai when graphing completes", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    job.current_stage = "graphing";
    job.status = "running";

    await harness.stageEventsRepo.record({
      jobId: job.id,
      stage: "extracting",
      eventType: "repo.files.indexed",
      payload: { manifestKey: "manifest.json", fileCount: 10 },
    });

    await harness.service.handleGraphBuilt(
      envelope("repo.graph.built", {
        commitSha: "abc123",
        graphs: {
          folder: { nodes: 1, edges: 0 },
          dependency: { nodes: 1, edges: 0 },
          symbol: { nodes: 1, edges: 0 },
        },
        ...stageProgress({ stage: "graphing" }),
      })
    );

    expect(job.current_stage).toBe("embedding");
    expect(harness.send).toHaveBeenCalledWith(
      "repo.index.requested",
      expect.objectContaining({
        eventType: "repo.index.requested",
        payload: expect.objectContaining({ manifestKey: "manifest.json" }),
      }),
      {}
    );
  });

  it("activates the snapshot only on completion, never earlier", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;
    job.current_stage = "embedding";
    job.status = "running";
    job.snapshot_id = "123e4567-e89b-12d3-a456-426614174099";

    expect(harness.activateSnapshot).not.toHaveBeenCalled();

    await harness.service.handleEmbeddingsCompleted(
      envelope("repo.embeddings.completed", {
        commitSha: "abc123",
        chunkCount: 20,
        embeddedCount: 20,
        reusedCount: 0,
        promptTokens: 100,
        embeddingModel: "text-embedding-3-small",
        ...stageProgress({ stage: "embedding" }),
      })
    );

    expect(harness.activateSnapshot).toHaveBeenCalledWith(REPO_ID, job.snapshot_id);
    expect(job.status).toBe("completed");
    expect(harness.send).toHaveBeenCalledWith("repo.processing.completed", expect.anything(), {});
  });

  it("retries a retryable stage failure with backoff and increments retry_count", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    await harness.service.handleStageFailed(
      envelope("repo.stage.failed", {
        stage: "snapshotting",
        errorCode: "SNAPSHOT_DOWNLOAD_FAILED",
        message: "download timed out",
        retryable: true,
        detail: {},
      })
    );

    expect(job.status).toBe("running");
    expect(job.retry_count).toBe(1);
    expect(harness.send).toHaveBeenCalledWith(
      "repo.import.requested",
      expect.anything(),
      { startAfter: 30 }
    );
  });

  it("fails the job once retries are exhausted", async () => {
    harness = buildHarness({ MAX_RETRY_COUNT: 1 });
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    const failure = envelope("repo.stage.failed", {
      stage: "snapshotting",
      errorCode: "SNAPSHOT_DOWNLOAD_FAILED",
      message: "download timed out",
      retryable: true,
      detail: {},
    });

    await harness.service.handleStageFailed(failure); // retry 1/1
    expect(job.status).toBe("running");
    await harness.service.handleStageFailed(failure); // exhausted

    expect(job.status).toBe("failed");
    expect(job.current_stage).toBe("failed");
    expect(harness.send).toHaveBeenCalledWith("repo.processing.failed", expect.anything(), {});
  });

  it("fails immediately for a non-retryable stage failure", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    await harness.service.handleStageFailed(
      envelope("repo.stage.failed", {
        stage: "snapshotting",
        errorCode: "ARCHIVE_UNSAFE",
        message: "archive contained a path traversal entry",
        retryable: false,
        detail: {},
      })
    );

    expect(job.status).toBe("failed");
    expect(job.error_code).toBe("ARCHIVE_UNSAFE");
  });

  it("cancels a running job and rejects cancelling a finished one", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    const cancelled = await harness.service.cancelJob(job.id);
    expect(cancelled.status).toBe("cancelled");

    await expect(harness.service.cancelJob(job.id)).rejects.toThrow();
  });

  it("resumes a failed job into its failed stage on manual retry, resetting retry_count", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    await harness.service.handleStageFailed(
      envelope("repo.stage.failed", {
        stage: "snapshotting",
        errorCode: "ARCHIVE_UNSAFE",
        message: "boom",
        retryable: false,
        detail: {},
      })
    );
    expect(job.status).toBe("failed");

    const resumed = await harness.service.retryJob(job.id);

    expect(resumed.status).toBe("running");
    expect(resumed.current_stage).toBe("snapshotting");
    expect(resumed.retry_count).toBe(0);
  });

  it("rejects manual retry for a job that hasn't failed", async () => {
    await harness.service.handleImportRequested(envelope("repo.import.requested", importPayload));
    const job = [...harness.jobsRepo.jobs.values()][0]!;

    await expect(harness.service.retryJob(job.id)).rejects.toThrow();
  });
});
