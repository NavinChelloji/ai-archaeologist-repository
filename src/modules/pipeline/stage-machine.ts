import {
  STAGE_PROGRESS_RANGES,
  statusForStage,
  type JobStage,
  type JobStatus,
  type ProcessingStage,
} from "@aca/contracts";

/**
 * The stage machine as data (JOB_ORCHESTRATOR_SERVICE_PLAN.md "Stage
 * Machine"): `queued -> snapshotting -> extracting -> parsing -> graphing ->
 * embedding -> completed`, with `failed` and `cancelled` reachable from any
 * running stage. Allowed transitions are asserted in code, not improvised
 * inline at each call site.
 */
const NEXT_STAGE: Partial<Record<JobStage, JobStage>> = {
  queued: "snapshotting",
  snapshotting: "extracting",
  extracting: "parsing",
  parsing: "graphing",
  graphing: "embedding",
  embedding: "completed",
};

export function nextStage(current: JobStage): JobStage {
  const next = NEXT_STAGE[current];
  if (!next) {
    throw new Error(`No stage follows "${current}" in the stage machine`);
  }
  return next;
}

/** `failed` and `cancelled` are reachable from any non-terminal stage; forward progression must follow `NEXT_STAGE`. */
export function isValidTransition(from: JobStage, to: JobStage): boolean {
  if (to === "failed" || to === "cancelled") {
    return from !== "completed" && from !== "failed" && from !== "cancelled";
  }
  return NEXT_STAGE[from] === to;
}

export { statusForStage };
export type { JobStage, JobStatus };

/**
 * Interpolates progress within a stage's fixed percent range from batch
 * counts (JOB_ORCHESTRATOR_SERVICE_PLAN.md: "No stage reports a percentage
 * it cannot substantiate").
 */
export function interpolateProgress(stage: ProcessingStage, itemsProcessed: number, totalItems: number): number {
  const range = STAGE_PROGRESS_RANGES[stage];
  if (totalItems <= 0) {
    return range.min;
  }
  const fraction = Math.min(Math.max(itemsProcessed / totalItems, 0), 1);
  return Math.round(range.min + fraction * (range.max - range.min));
}

/** The fixed percent a stage starts at the moment it's entered. */
export function stageEntryProgress(stage: JobStage): number {
  return STAGE_PROGRESS_RANGES[stage as keyof typeof STAGE_PROGRESS_RANGES]?.min ?? 0;
}

/** Human-readable progress line for `ProcessingJobDto.message` / SSE payloads. */
export function buildProgressMessage(stage: JobStage, itemsProcessed?: number, totalItems?: number): string {
  if (typeof itemsProcessed === "number" && typeof totalItems === "number" && totalItems > 0) {
    return `${STAGE_LABELS[stage]}: ${itemsProcessed.toLocaleString()} of ${totalItems.toLocaleString()}`;
  }
  return STAGE_LABELS[stage];
}

const STAGE_LABELS: Record<JobStage, string> = {
  queued: "Queued",
  snapshotting: "Downloading repository snapshot",
  extracting: "Extracting files",
  parsing: "Parsing symbols and imports",
  graphing: "Building graphs",
  embedding: "Generating embeddings",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
