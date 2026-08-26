import { Injectable } from "@nestjs/common";
import { SnapshotsRepository } from "./snapshots.repository";

/**
 * Public surface for the snapshot half of this module (RULES.md #2 — other
 * modules, e.g. Parser, must go through here rather than touching
 * `repository_snapshots` directly).
 */
@Injectable()
export class SnapshotsService {
  constructor(private readonly snapshots: SnapshotsRepository) {}

  /** Called by the Parser module once `manifest.json` is written and the file count is known. */
  async recordManifest(snapshotId: string, input: { manifestKey: string; fileCount: number }): Promise<void> {
    await this.snapshots.markManifest(snapshotId, input);
  }
}
