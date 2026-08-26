import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type PgBoss from "pg-boss";
import { AppError, type TypedEnvelope } from "@aca/contracts";
import { publishJob } from "@aca/queue";
import type { Logger } from "@aca/logger";
import { archiveObjectKey, putObject, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { IndexerEnv } from "../../config/env";
import { APP_LOGGER, PG_BOSS, S3_CLIENT } from "../../shared/infra.module";
import { GithubTarballClient } from "./github-tarball.client";
import { GithubTokenClient } from "./github-token.client";
import { RepositoriesRepository } from "./repositories.repository";
import { SnapshotsRepository, type SnapshotRow } from "./snapshots.repository";

/**
 * Reacts to `repo.import.requested` on this module's own fan-out queue
 * (`FANOUT_QUEUES` in `@aca/queue` — the Pipeline module also consumes the
 * same event, on its own queue, purely for job bookkeeping). Resolves the
 * head commit, downloads the GitHub tarball, uploads it to S3, and
 * publishes `repo.snapshot.created` so the Parser module and Pipeline can
 * both react (GITHUB_CONNECTOR_SERVICE_PLAN.md "Flow Chart").
 */
@Injectable()
export class SnapshotDownloadService {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(APP_CONFIG) private readonly config: IndexerEnv,
    @Inject(APP_LOGGER) private readonly logger: Logger,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly repositories: RepositoriesRepository,
    private readonly snapshots: SnapshotsRepository,
    private readonly tokens: GithubTokenClient,
    private readonly tarball: GithubTarballClient
  ) {}

  async handleImportRequested(envelope: TypedEnvelope<"repo.import.requested">): Promise<void> {
    const repoId = envelope.repoId;
    if (!repoId) {
      throw new Error("Expected repo.import.requested to carry a repoId");
    }

    const startedAt = Date.now();
    try {
      const repository = await this.repositories.findById(repoId);
      if (!repository) {
        this.logger.warn({ repoId }, "repo.import.requested for an unknown or deleted repository, skipping");
        return;
      }

      const token = await this.tokens.fetchToken(envelope.userId);
      const ref = envelope.payload.ref ?? repository.default_branch;
      const commitSha = await this.tarball.resolveHeadSha(repository.full_name, ref, token);

      const existing = await this.snapshots.findByRepoAndSha(repoId, commitSha);
      if (existing && (existing.status === "stored" || existing.status === "active")) {
        // GITHUB_CONNECTOR_SERVICE_PLAN.md "Re-import at an unchanged SHA is
        // a no-op returning the existing snapshot" — no download, no S3
        // write. The rest of the pipeline (extract/parse/graph/embed) still
        // runs against it; a full "skip straight to completion" fast path
        // is out of scope until later stages give it something correct to
        // report (symbol/chunk counts) — tracked, not silently dropped.
        await this.publishSnapshotCreated(envelope, existing, { ref, reused: true, durationMs: Date.now() - startedAt });
        return;
      }

      const snapshotId = existing?.id ?? randomUUID();
      if (!existing) {
        await this.snapshots.createPending({ id: snapshotId, repoId, commitSha, ref });
      }
      await this.snapshots.markDownloading(snapshotId);

      await mkdir(this.config.TEMP_WORK_DIR, { recursive: true });
      const tempDir = await mkdtemp(join(this.config.TEMP_WORK_DIR, "snap-"));
      try {
        const archivePath = join(tempDir, "archive.tar.gz");
        const { sizeBytes } = await this.tarball.downloadTarball({
          fullName: repository.full_name,
          commitSha,
          token,
          destPath: archivePath,
        });

        const archiveKey = archiveObjectKey(repoId, snapshotId);
        await putObject(this.s3, {
          bucket: this.config.S3_BUCKET,
          key: archiveKey,
          body: createReadStream(archivePath),
          contentType: "application/gzip",
          contentLength: sizeBytes,
        });

        const stored = await this.snapshots.markStored(snapshotId, { archiveKey, sizeBytes });
        await this.publishSnapshotCreated(envelope, stored, { ref, reused: false, durationMs: Date.now() - startedAt });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      await this.handleFailure(envelope, err);
    }
  }

  private async publishSnapshotCreated(
    envelope: TypedEnvelope<"repo.import.requested">,
    snapshot: SnapshotRow,
    extra: { ref: string; reused: boolean; durationMs: number }
  ): Promise<void> {
    await publishJob(this.boss, {
      eventType: "repo.snapshot.created",
      payload: {
        commitSha: snapshot.commit_sha,
        ref: extra.ref,
        archiveKey: snapshot.archive_key!,
        sizeBytes: Number(snapshot.size_bytes ?? 0),
        reused: extra.reused,
        stage: "snapshotting",
        batchIndex: 0,
        batchCount: 1,
        itemsProcessed: 1,
        totalItems: 1,
        durationMs: extra.durationMs,
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId: envelope.repoId,
      snapshotId: snapshot.id,
    });
  }

  private async handleFailure(envelope: TypedEnvelope<"repo.import.requested">, err: unknown): Promise<void> {
    const appError =
      err instanceof AppError
        ? err
        : new AppError("SNAPSHOT_DOWNLOAD_FAILED", "Downloading the repository snapshot failed.", { cause: err });

    this.logger.error({ err: appError, repoId: envelope.repoId }, "snapshot download failed");

    await publishJob(this.boss, {
      eventType: "repo.stage.failed",
      payload: {
        stage: "snapshotting",
        errorCode: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        detail: {},
      },
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      userId: envelope.userId,
      repoId: envelope.repoId,
      snapshotId: null,
    });
  }
}
