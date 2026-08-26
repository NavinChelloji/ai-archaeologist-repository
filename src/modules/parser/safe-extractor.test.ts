import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeExtract } from "./safe-extractor";
import { buildTarGz } from "./test-support";

const DEFAULT_LIMITS = {
  maxFileSizeBytes: 1024 * 1024,
  maxExtractedSizeBytes: 10 * 1024 * 1024,
  maxFiles: 1000,
  maxDirectoryDepth: 32,
};

let destDir: string;

beforeEach(async () => {
  destDir = await mkdtemp(join(tmpdir(), "aca-extract-test-"));
});

afterEach(async () => {
  await rm(destDir, { recursive: true, force: true });
});

describe("safeExtract", () => {
  it("extracts regular files and reports their paths and sizes", async () => {
    const archive = await buildTarGz([
      { name: "repo-abc/src/app.ts", content: "export const x = 1;\n" },
      { name: "repo-abc/README.md", content: "# hello\n" },
    ]);

    const result = await safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS });

    expect(result.files).toHaveLength(2);
    const appFile = result.files.find((f) => f.path === "repo-abc/src/app.ts");
    expect(appFile).toBeTruthy();
    expect(appFile!.sizeBytes).toBe(Buffer.byteLength("export const x = 1;\n"));
    const onDisk = await readFile(appFile!.absolutePath, "utf8");
    expect(onDisk).toBe("export const x = 1;\n");
  });

  it("rejects an archive entry that attempts path traversal", async () => {
    const archive = await buildTarGz([{ name: "../../etc/passwd", content: "root:x:0:0" }]);

    await expect(safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS })).rejects.toMatchObject({
      code: "ARCHIVE_UNSAFE",
    });
  });

  it("rejects an absolute-path archive entry", async () => {
    const archive = await buildTarGz([{ name: "/etc/passwd", content: "root:x:0:0" }]);

    await expect(safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS })).rejects.toMatchObject({
      code: "ARCHIVE_UNSAFE",
    });
  });

  it("rejects a symlink entry without following it", async () => {
    const archive = await buildTarGz([{ name: "repo-abc/evil-link", type: "symlink", linkname: "/etc/passwd" }]);

    await expect(safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS })).rejects.toMatchObject({
      code: "ARCHIVE_UNSAFE",
    });
  });

  it("rejects a hardlink entry", async () => {
    const archive = await buildTarGz([{ name: "repo-abc/evil-link", type: "link", linkname: "repo-abc/src/app.ts" }]);

    await expect(safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS })).rejects.toMatchObject({
      code: "ARCHIVE_UNSAFE",
    });
  });

  it("skips (does not fail) a single file above the per-file size limit", async () => {
    const archive = await buildTarGz([
      { name: "repo-abc/huge.bin", content: "x".repeat(2000) },
      { name: "repo-abc/small.ts", content: "ok" },
    ]);

    const result = await safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS, maxFileSizeBytes: 1000 });

    expect(result.skippedTooLarge).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(["repo-abc/small.ts"]);
  });

  it("aborts the whole job when cumulative extracted size exceeds the zip-bomb limit", async () => {
    const archive = await buildTarGz([
      { name: "repo-abc/a.txt", content: "x".repeat(600) },
      { name: "repo-abc/b.txt", content: "x".repeat(600) },
    ]);

    await expect(
      safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS, maxFileSizeBytes: 1000, maxExtractedSizeBytes: 1000 })
    ).rejects.toMatchObject({ code: "ARCHIVE_UNSAFE" });
  });

  it("aborts when the entry count exceeds the per-repo file cap", async () => {
    const archive = await buildTarGz([
      { name: "repo-abc/a.txt", content: "1" },
      { name: "repo-abc/b.txt", content: "2" },
      { name: "repo-abc/c.txt", content: "3" },
    ]);

    await expect(safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS, maxFiles: 2 })).rejects.toMatchObject({
      code: "REPO_TOO_MANY_FILES",
    });
  });

  it("skips (does not fail) an entry nested past the directory depth cap", async () => {
    const archive = await buildTarGz([
      { name: "repo-abc/a/b/c/d/deep.txt", content: "deep" },
      { name: "repo-abc/shallow.txt", content: "shallow" },
    ]);

    const result = await safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS, maxDirectoryDepth: 3 });

    expect(result.skippedTooDeep).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(["repo-abc/shallow.txt"]);
  });

  it("extracts nothing but does not error for an empty archive", async () => {
    const archive = await buildTarGz([]);

    const result = await safeExtract({ archiveStream: archive, destDir, ...DEFAULT_LIMITS });

    expect(result.files).toHaveLength(0);
  });
});
