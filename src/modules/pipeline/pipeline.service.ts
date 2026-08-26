import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type PgBoss from "pg-boss";
import {
  AppError,
  type BuildEnvelopeInput,
  type JobName,
  type JobStage,
  type ProcessingStage,
  type TypedEnvelope,
} from "@aca/contracts";
import { publishJob, retryBackoffSeconds } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS } from "../../shared/infra.module";
import { RepositoriesService } from "../repositories/repositories.service";
import { JobStageEventsRepository } from "./job-stage-events.repository";
import { ProcessingJobsRepository, type ProcessingJobRow } from "./processing-jobs.repository";
import { ProgressPublisherService } from "./progress-publisher.service";
import { buildProgressMessage, interpolateProgress, stageEntryProgress, statusForStage } from "./stage-machine";

interface BatchedPayload {
  batchIndex: number;
  batchCount: number;
  itemsProcessed: number;
  totalItems: number;
  durationMs: number;
}

/** Which job, if replayed, re-enters a given stage — the resume source for both automatic and manual retry. */
const RESUME_TRIGGER: Partial<Record<JobStage, JobName>> = {
  snapshotting: "repo.import.requested",
  extracting: "repo.snapshot.created",
  parsing: "repo.snapshot.created",
  // The Graph module has no single owning trigger event (it fires once all
  // three parser terminals have arrived) — re-running the parser is the
  // closest generic resume available until Stage 7 adds its own module.
  graphing: "repo.snapshot.created",
  embedding: "repo.index.requested",
};

/**
 * Owns indexing job state end to end (JOB_ORCHESTRATOR_SERVICE_PLAN.md
 * "Purpose"): creates and advances `processing_jobs`, classifies and
 * retries failures, triggers the atomic snapshot cutover, and publishes
 * progress. Every consumed event's payload is logged verbatim to
 * `job_stage_events`, which doubles as the replay source for retries — see
 * `job-stage-events.repository.ts`.
 */
@Injectable()
export class PipelineService {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    private readonly jobs: ProcessingJobsRepository,
    private readonly stageEvents: JobStageEventsRepository,
    private readonly progress: ProgressPublisherService,
    private readonly repositories: RepositoriesService
  ) {}

  async handleImportRequested(envelope: TypedEnvelope<"repo.import.requested">): Promise<void> {
    const repoId = this.requireRepoId(envelope);

    const job = await this.jobs.create({
      id: randomUUID(),
      repoId,
      requestedBy: envelope.userId,
      correlationId: envelope.correlationId,
    });

    if (!job) {
      this.logger.info({ repoId }, "an import job is already active for this repository, skipping");
      return;
    }

    await this.stageEvents.record({
      jobId: job.id,
      stage: "snapshotting",
      eventType: envelope.eventType,
      payload: envelope.payload,
    });

    await this.enterStage(job.id, repoId, "snapshotting");
  }

  async handleSnapshotCreated(envelope: TypedEnvelope<"repo.snapshot.created">): Promise<void> {
    const job = await this.findActiveJobForBookkeeping(envelope);
    if (!job) return;

    await this.recordAndMaybeAdvance(job, envelope, "snapshotting", "extracting", envelope.snapshotId);
  }

  async handleFilesIndexed(envelope: TypedEnvelope<"repo.files.indexed">): Promise<void> {
    const job = await this.findActiveJobForBookkeeping(envelope);
    if (!job) return;

    const advanced = await this.recordAndMaybeAdvance(job, envelope, "extracting", "parsing");
    if (!advanced) return;

    // Both parsing terminals may have already arrived and been recorded while the job was still
    // "extracting" (pg-boss gives no cross-queue ordering guarantee — see handleParsingTerminal).
    await this.tryAdvancePastParsing(job);
  }

  async handleSymbolsExtracted(envelope: TypedEnvelope<"repo.symbols.extracted">): Promise<void> {
    await this.handleParsingTerminal(envelope);
  }

  async handleDependenciesExtracted(envelope: TypedEnvelope<"repo.dependencies.extracted">): Promise<void> {
    await this.handleParsingTerminal(envelope);
  }

  async handleGraphBuilt(envelope: TypedEnvelope<"repo.graph.built">): Promise<void> {
    const job = await this.findActiveJobForBookkeeping(envelope);
    if (!job) return;

    const advanced = await this.recordAndMaybeAdvance(job, envelope, "graphing", "embedding");
    if (!advanced) return;

    await this.requestEmbeddings(job, envelope.payload.commitSha, envelope.eventId);
  }

  async handleEmbeddingsCompleted(envelope: TypedEnvelope<"repo.embeddings.completed">): Promise<void> {
    const job = await this.findActiveJobForBookkeeping(envelope);
    if (!job) return;

    await this.stageEvents.record({
      jobId: job.id,
      stage: "embedding",
      eventType: envelope.eventType,
      itemsProcessed: envelope.payload.itemsProcessed,
      totalItems: envelope.payload.totalItems,
      durationMs: envelope.payload.durationMs,
      payload: envelope.payload,
    });

    if (!this.isTerminalBatch(envelope.payload)) {
      if (job.current_stage === "embedding") {
        await this.jobs.updateProgress(job.id, interpolateProgress("embedding", envelope.payload.itemsProcessed, envelope.payload.totalItems));
      }
      return;
    }

    if (job.current_stage !== "embedding") {
      this.logger.info({ jobId: job.id, actualStage: job.current_stage }, "recorded repo.embeddings.completed ahead of the job reaching embedding");
      return;
    }

    await this.completeJob(job, envelope);
  }

  async handleStageFailed(envelope: TypedEnvelope<"repo.stage.failed">): Promise<void> {
    const repoId = this.requireRepoId(envelope);
    const job = await this.jobs.findActiveByRepoId(repoId);
    if (!job) {
      this.logger.warn({ repoId }, "repo.stage.failed with no active job, skipping");
      return;
    }

    await this.stageEvents.record({
      jobId: job.id,
      stage: envelope.payload.stage,
      eventType: envelope.eventType,
      payload: envelope.payload,
    });

    if (envelope.payload.retryable && job.retry_count < this.config.MAX_RETRY_COUNT) {
      await this.retryStage(job, job.current_stage, { manual: false, causationId: envelope.eventId });
      return;
    }

    await this.failJob(job, envelope.payload.errorCode, envelope.payload.message, envelope.eventId);
  }

  async getJob(jobId: string): Promise<ProcessingJobRow | null> {
    return this.jobs.findById(jobId);
  }

  async getLatestJobForRepo(repoId: string): Promise<ProcessingJobRow | null> {
    return this.jobs.findLatestByRepoId(repoId);
  }

  async cancelJob(jobId: string): Promise<ProcessingJobRow> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new AppError("JOB_NOT_FOUND", "This job does not exist.");
    if (job.status !== "queued" && job.status !== "running") {
      throw new AppError("CONFLICT", "This job has already finished and cannot be cancelled.");
    }

    const cancelled = await this.jobs.markCancelled(jobId);
    await this.publishProgress(cancelled, "Cancelled");
    return cancelled;
  }

  async retryJob(jobId: string): Promise<ProcessingJobRow> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new AppError("JOB_NOT_FOUND", "This job does not exist.");
    if (job.status !== "failed") {
      throw new AppError("CONFLICT", "Only a failed job can be retried.");
    }

    const failure = await this.stageEvents.findLatestFailure(job.id);
    if (!failure) {
      throw new AppError("INTERNAL_ERROR", "No recorded failure to resume from.");
    }

    return this.retryStage(job, failure.stage as JobStage, { manual: true, causationId: failure.id });
  }

  /** Called by the stalled-job sweeper — a worker vanished mid-stage, so there's no `repo.stage.failed` to react to. */
  async failStalled(job: ProcessingJobRow): Promise<void> {
    await this.failJob(
      job,
      "STAGE_TIMEOUT",
      `Stage "${job.current_stage}" exceeded ${this.config.STAGE_TIMEOUT_SECONDS}s and was marked failed.`,
      randomUUID()
    );
  }

  // -- internals --------------------------------------------------------

  private requireRepoId(envelope: { repoId: string | null }): string {
    if (!envelope.repoId) {
      throw new Error("Expected a repo-scoped envelope with a non-null repoId");
    }
    return envelope.repoId;
  }

  private isTerminalBatch(payload: BatchedPayload): boolean {
    return payload.batchIndex === payload.batchCount - 1;
  }

  /**
   * Finds the active (queued/running) job for this envelope's repo,
   * without regard to its current stage — stage-appropriateness is decided
   * separately by whichever caller records against it (`recordAndMaybeAdvance`,
   * `handleParsingTerminal`), since pg-boss gives no ordering guarantee
   * between the independent queues these events travel on and an event for
   * a not-yet-reached or already-passed stage is still real bookkeeping
   * that must not be silently dropped.
   */
  private async findActiveJobForBookkeeping(envelope: { repoId: string | null; eventType: string }): Promise<ProcessingJobRow | null> {
    const repoId = this.requireRepoId(envelope);
    const job = await this.jobs.findActiveByRepoId(repoId);
    if (!job) {
      this.logger.info({ repoId, eventType: envelope.eventType }, "no active job for this stage event, skipping");
      return null;
    }
    return job;
  }

  /** Logs the event; on its terminal batch, advances to `toStage` and returns true. Returns false otherwise. */
  /**
   * Records the event unconditionally (bookkeeping must never be dropped),
   * then advances `fromStage` -> `toStage` only if the job is actually
   * still at `fromStage`. If it's already moved past that (a different,
   * independent consumer got there first, or this event itself arrived
   * late), the advance is skipped — not re-applied, not treated as an
   * error — since someone else already did it or will. Returns whether it
   * advanced *this call*, not whether the job is now at `toStage` by some
   * other route.
   */
  private async recordAndMaybeAdvance(
    job: ProcessingJobRow,
    envelope: TypedEnvelope<JobName> & { payload: BatchedPayload },
    fromStage: ProcessingStage,
    toStage: JobStage,
    snapshotId?: string | null
  ): Promise<boolean> {
    await this.stageEvents.record({
      jobId: job.id,
      stage: fromStage,
      eventType: envelope.eventType,
      itemsProcessed: envelope.payload.itemsProcessed,
      totalItems: envelope.payload.totalItems,
      durationMs: envelope.payload.durationMs,
      // The union of every job's payload shape has no common index
      // signature; each member is already a plain object once it round-
      // tripped through JSON in the queue, so this is a safe widening.
      payload: envelope.payload as unknown as Record<string, unknown>,
    });

    if (!this.isTerminalBatch(envelope.payload)) {
      if (job.current_stage === fromStage) {
        await this.jobs.updateProgress(job.id, interpolateProgress(fromStage, envelope.payload.itemsProcessed, envelope.payload.totalItems));
      }
      return false;
    }

    if (job.current_stage !== fromStage) {
      this.logger.info(
        { jobId: job.id, expectedStage: fromStage, actualStage: job.current_stage },
        "recorded a stage event whose transition was already applied via a different path"
      );
      return false;
    }

    await this.enterStage(job.id, job.repo_id, toStage, snapshotId);
    return true;
  }

  /**
   * `repo.symbols.extracted` and `repo.dependencies.extracted` are both
   * terminal-for-parsing; advance only once both have arrived
   * (order-independent). Pipeline and the Graph module each consume their
   * own fan-out copy of these events completely independently (`@aca/queue`
   * FANOUT_QUEUES), and pg-boss gives no ordering guarantee *between*
   * queues — so a terminal can legitimately arrive here before Pipeline has
   * even processed `repo.files.indexed` and advanced the job into
   * "parsing" yet. It's still recorded (bookkeeping must never be dropped —
   * `requestEmbeddings` depends on `repo.files.indexed` having been
   * recorded, for example), just not used to advance the stage until the
   * job has actually reached "parsing" — see `handleFilesIndexed`'s call to
   * `tryAdvancePastParsing` for the other half of this.
   */
  private async handleParsingTerminal(
    envelope: TypedEnvelope<"repo.symbols.extracted" | "repo.dependencies.extracted">
  ): Promise<void> {
    const job = await this.findActiveJobForBookkeeping(envelope);
    if (!job) return;

    await this.stageEvents.record({
      jobId: job.id,
      stage: "parsing",
      eventType: envelope.eventType,
      itemsProcessed: envelope.payload.itemsProcessed,
      totalItems: envelope.payload.totalItems,
      durationMs: envelope.payload.durationMs,
      payload: envelope.payload,
    });

    if (!this.isTerminalBatch(envelope.payload)) {
      if (job.current_stage === "parsing") {
        await this.jobs.updateProgress(job.id, interpolateProgress("parsing", envelope.payload.itemsProcessed, envelope.payload.totalItems));
      }
      return;
    }

    if (job.current_stage !== "parsing") {
      this.logger.info({ jobId: job.id, actualStage: job.current_stage }, "recorded a parsing terminal event ahead of the job reaching parsing");
      return;
    }

    await this.tryAdvancePastParsing(job);
  }

  /** Advances "parsing" -> "graphing" iff both parsing terminals are recorded and terminal — called both from the transition into "parsing" and from each terminal handler, since either can be the one that completes the pair. */
  private async tryAdvancePastParsing(job: ProcessingJobRow): Promise<void> {
    const symbols = await this.stageEvents.findLatestByEventType(job.id, "repo.symbols.extracted");
    const dependencies = await this.stageEvents.findLatestByEventType(job.id, "repo.dependencies.extracted");
    const bothTerminal =
      symbols && this.isTerminalBatch(symbols.payload as unknown as BatchedPayload) &&
      dependencies && this.isTerminalBatch(dependencies.payload as unknown as BatchedPayload);

    if (!bothTerminal) {
      this.logger.info({ jobId: job.id }, "waiting for the other parsing terminal event before advancing to graphing");
      return;
    }

    await this.enterStage(job.id, job.repo_id, "graphing");
    // repo.graph.built is published by a fully independent consumer of these same three events (the
    // Graph module) and may already have arrived — and been recorded but not acted on — before this job
    // reached "graphing" itself, for the identical cross-queue-ordering reason.
    await this.tryAdvancePastGraphing(job);
  }

  /** Advances "graphing" -> "embedding" and requests embeddings iff repo.graph.built is already recorded and terminal. */
  private async tryAdvancePastGraphing(job: ProcessingJobRow): Promise<void> {
    const graphBuilt = await this.stageEvents.findLatestByEventType(job.id, "repo.graph.built");
    if (!graphBuilt || !this.isTerminalBatch(graphBuilt.payload as unknown as BatchedPayload)) return;

    await this.enterStage(job.id, job.repo_id, "embedding");
    const commitSha = (graphBuilt.payload as { commitSha?: string }).commitSha;
    if (!commitSha) {
      this.logger.error({ jobId: job.id }, "recorded repo.graph.built has no commitSha, cannot request embeddings");
      return;
    }
    await this.requestEmbeddings(job, commitSha, randomUUID());
  }

  private async requestEmbeddings(job: ProcessingJobRow, commitSha: string, causationId: string): Promise<void> {
    const filesIndexed = await this.stageEvents.findLatestByEventType(job.id, "repo.files.indexed");
    const manifestKey = (filesIndexed?.payload as { manifestKey?: string } | undefined)?.manifestKey;
    if (!manifestKey) {
      this.logger.error({ jobId: job.id }, "missing manifestKey from repo.files.indexed, cannot request embeddings");
      return;
    }

    const repository = await this.repositories.getById(job.repo_id);

    await publishJob(this.boss, {
      eventType: "repo.index.requested",
      payload: {
        commitSha,
        manifestKey,
        previousSnapshotId: repository.activeSnapshotId,
      },
      correlationId: job.correlation_id,
      causationId,
      userId: job.requested_by,
      repoId: job.repo_id,
      snapshotId: job.snapshot_id,
    });
  }

  private async completeJob(job: ProcessingJobRow, envelope: TypedEnvelope<"repo.embeddings.completed">): Promise<void> {
    if (job.snapshot_id) {
      // CODEBASE.md "Snapshot Lifecycle": cutover happens exactly here, atomically, at repo.processing.completed.
      await this.repositories.activateSnapshot(job.repo_id, job.snapshot_id);
    } else {
      this.logger.error({ jobId: job.id }, "completing without a snapshot id — cutover skipped");
    }

    const row = await this.enterStage(job.id, job.repo_id, "completed", job.snapshot_id);

    const filesIndexed = await this.stageEvents.findLatestByEventType(job.id, "repo.files.indexed");
    const symbolsExtracted = await this.stageEvents.findLatestByEventType(job.id, "repo.symbols.extracted");
    const fileCount = (filesIndexed?.payload as { fileCount?: number } | undefined)?.fileCount ?? 0;
    const symbolCount = (symbolsExtracted?.payload as { symbolCount?: number } | undefined)?.symbolCount ?? 0;
    const durationMs = row.started_at ? Date.now() - row.started_at.getTime() : 0;

    await publishJob(this.boss, {
      eventType: "repo.processing.completed",
      payload: {
        commitSha: envelope.payload.commitSha,
        jobId: job.id,
        durationMs,
        fileCount,
        symbolCount,
        chunkCount: envelope.payload.chunkCount,
      },
      correlationId: job.correlation_id,
      causationId: envelope.eventId,
      userId: job.requested_by,
      repoId: job.repo_id,
      snapshotId: job.snapshot_id,
    });
  }

  private async failJob(job: ProcessingJobRow, errorCode: string, message: string, causationId: string): Promise<void> {
    const failed = await this.jobs.markFailed(job.id, errorCode, message);
    await this.publishProgress(failed, message);

    await publishJob(this.boss, {
      eventType: "repo.processing.failed",
      payload: {
        jobId: job.id,
        stage: job.current_stage,
        errorCode,
        message,
        retryCount: job.retry_count,
      },
      correlationId: job.correlation_id,
      causationId,
      userId: job.requested_by,
      repoId: job.repo_id,
      snapshotId: job.snapshot_id,
    });
  }

  private async retryStage(
    job: ProcessingJobRow,
    stage: JobStage,
    options: { manual: boolean; causationId: string }
  ): Promise<ProcessingJobRow> {
    const resumeEventType = RESUME_TRIGGER[stage];
    if (!resumeEventType) {
      await this.failJob(job, "INTERNAL_ERROR", `Stage "${stage}" cannot be retried.`, options.causationId);
      return this.jobs.findById(job.id) as Promise<ProcessingJobRow>;
    }

    const replay = await this.stageEvents.findLatestByEventType(job.id, resumeEventType);
    if (!replay) {
      await this.failJob(job, "INTERNAL_ERROR", "This stage could not be retried.", options.causationId);
      return this.jobs.findById(job.id) as Promise<ProcessingJobRow>;
    }

    let updated: ProcessingJobRow;
    let retryCount: number;
    if (options.manual) {
      updated = await this.jobs.resumeIntoStage(job.id, stage, stageEntryProgress(stage));
      await this.jobs.resetRetryCount(job.id);
      retryCount = 0;
    } else {
      updated = await this.jobs.incrementRetry(job.id);
      retryCount = updated.retry_count;
    }

    const delaySeconds = options.manual ? undefined : retryBackoffSeconds(retryCount, this.config.RETRY_BACKOFF_BASE_SECONDS);

    await publishJob(
      this.boss,
      {
        eventType: resumeEventType,
        // Runtime-validated by buildEnvelope's Zod parse against
        // resumeEventType's own schema — this payload was itself only ever
        // stored here after passing that same validation on first receipt.
        payload: replay.payload,
        correlationId: job.correlation_id,
        causationId: options.causationId,
        userId: job.requested_by,
        repoId: job.repo_id,
        snapshotId: job.snapshot_id,
        retryCount,
      } as unknown as BuildEnvelopeInput<JobName>,
      delaySeconds
    );

    await this.publishProgress(updated, `Retrying: ${buildProgressMessage(stage)} (attempt ${retryCount})`);
    return updated;
  }

  private async enterStage(jobId: string, repoId: string, stage: JobStage, snapshotId?: string | null): Promise<ProcessingJobRow> {
    const status = statusForStage(stage);
    const progressPercent = stageEntryProgress(stage);
    const row = await this.jobs.advanceStage(jobId, { stage, status, progressPercent, snapshotId });
    await this.publishProgress(row, buildProgressMessage(stage));
    return row;
  }

  private async publishProgress(row: ProcessingJobRow, message: string | null): Promise<void> {
    await this.progress.publish({
      repoId: row.repo_id,
      jobId: row.id,
      status: row.status,
      stage: row.current_stage,
      progressPercent: row.progress_percent,
      message,
      errorCode: row.error_code,
      occurredAt: new Date().toISOString(),
    });
  }
}
