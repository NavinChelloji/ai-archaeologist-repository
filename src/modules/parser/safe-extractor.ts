import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tarStream from "tar-stream";
import { AppError } from "@aca/contracts";

export interface SafeExtractOptions {
  /** Not buffered to disk first — piped straight through gunzip into the extractor (RULES.md #9 "stream large files"). */
  archiveStream: Readable;
  /** Extraction root — must already exist and be empty. */
  destDir: string;
  maxFileSizeBytes: number;
  maxExtractedSizeBytes: number;
  maxFiles: number;
  maxDirectoryDepth: number;
}

export interface ExtractedFile {
  /** Forward-slash path relative to the archive root, including GitHub's wrapper directory — callers strip that separately. */
  path: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface SafeExtractResult {
  files: ExtractedFile[];
  skippedTooLarge: number;
  skippedTooDeep: number;
}

/**
 * Extracts a `.tar.gz` archive under six guards, in order
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Safe Extraction"). Guards 1–3
 * (traversal, escape, symlinks/hardlinks) and the zip-bomb/entry-count caps
 * abort the whole job as `ARCHIVE_UNSAFE` / `REPO_TOO_MANY_FILES` — these
 * only show up in a hostile or corrupt archive. A single oversized file or
 * one nested past `maxDirectoryDepth` is not evidence of malice by itself,
 * so those are skipped and tallied instead of failing the job.
 */
export async function safeExtract(options: SafeExtractOptions): Promise<SafeExtractResult> {
  const extractionRoot = resolve(options.destDir);
  const files: ExtractedFile[] = [];
  let cumulativeBytes = 0;
  let fileEntryCount = 0;
  let skippedTooLarge = 0;
  let skippedTooDeep = 0;

  const extract = tarStream.extract();

  extract.on("entry", (header, entryStream, next) => {
    handleEntry(header, entryStream)
      .then((outcome) => {
        if (outcome === "extracted") return;
        if (outcome === "too_large") skippedTooLarge += 1;
        if (outcome === "too_deep") skippedTooDeep += 1;
      })
      .then(next, (err: unknown) => {
        entryStream.destroy();
        extract.destroy(err instanceof Error ? err : new Error(String(err)));
      });
  });

  async function handleEntry(
    header: tarStream.Headers,
    entryStream: PassThrough
  ): Promise<"extracted" | "skipped" | "too_large" | "too_deep"> {
    if (header.type === "symlink" || header.type === "link") {
      entryStream.resume();
      throw new AppError("ARCHIVE_UNSAFE", "This archive contains a symlink or hardlink, which is not allowed.");
    }

    const relativePath = normalizeEntryPath(header.name);
    if (relativePath === null) {
      entryStream.resume();
      throw new AppError("ARCHIVE_UNSAFE", "This archive contains an unsafe file path.");
    }

    if (relativePath.split("/").length > options.maxDirectoryDepth) {
      entryStream.resume();
      return "too_deep";
    }

    if (header.type !== "file") {
      entryStream.resume();
      return "skipped";
    }

    fileEntryCount += 1;
    if (fileEntryCount > options.maxFiles) {
      entryStream.resume();
      throw new AppError("REPO_TOO_MANY_FILES", `This repository has more than ${options.maxFiles} files.`);
    }

    if ((header.size ?? 0) > options.maxFileSizeBytes) {
      entryStream.resume();
      return "too_large";
    }

    const absolutePath = join(extractionRoot, relativePath);
    // Defense in depth: normalizeEntryPath already rejects `..` and absolute
    // paths, but re-derive and re-check the resolved path so a future
    // change there can't silently reopen a traversal hole.
    if (absolutePath !== extractionRoot && !absolutePath.startsWith(extractionRoot + sep)) {
      entryStream.resume();
      throw new AppError("ARCHIVE_UNSAFE", "This archive contains an unsafe file path.");
    }

    await mkdir(dirname(absolutePath), { recursive: true });

    const outcome = await writeEntryToDisk(entryStream, absolutePath, {
      cumulativeBytesSoFar: cumulativeBytes,
      maxFileSizeBytes: options.maxFileSizeBytes,
      maxExtractedSizeBytes: options.maxExtractedSizeBytes,
    });
    cumulativeBytes += outcome.written;

    if (outcome.kind === "too_large") {
      return "too_large";
    }

    files.push({ path: relativePath, absolutePath, sizeBytes: outcome.written });
    return "extracted";
  }

  await pipeline(options.archiveStream, createGunzip(), extract).catch((err: unknown) => {
    if (err instanceof AppError) throw err;
    throw new AppError("ARCHIVE_UNSAFE", "This archive could not be read as a gzip-compressed tarball.", { cause: err });
  });

  return { files, skippedTooLarge, skippedTooDeep };
}

interface WriteEntryOptions {
  cumulativeBytesSoFar: number;
  maxFileSizeBytes: number;
  maxExtractedSizeBytes: number;
}

interface WriteEntryResult {
  kind: "written" | "too_large";
  written: number;
}

/**
 * Writes one entry's stream to disk, enforcing both limits against actual
 * bytes transferred rather than the tar header's (untrusted) declared size.
 * Exceeding the cumulative limit is a zip-bomb signal and rejects (caller
 * aborts the whole job); exceeding the per-file limit resolves as
 * `"too_large"` so the caller can skip just this one file.
 */
function writeEntryToDisk(entryStream: PassThrough, absolutePath: string, options: WriteEntryOptions): Promise<WriteEntryResult> {
  return new Promise((resolvePromise, reject) => {
    const writeStream = createWriteStream(absolutePath);
    let written = 0;
    let settled = false;

    const settle = (result: WriteEntryResult | Error): void => {
      if (settled) return;
      settled = true;
      entryStream.removeAllListeners("data");
      if (result instanceof Error) {
        writeStream.destroy();
        entryStream.destroy();
        reject(result);
      } else {
        resolvePromise(result);
      }
    };

    entryStream.on("data", (chunk: Buffer) => {
      if (settled) return;
      written += chunk.length;

      if (options.cumulativeBytesSoFar + written > options.maxExtractedSizeBytes) {
        settle(new AppError("ARCHIVE_UNSAFE", "This archive exceeds the extracted-size limit (possible zip bomb)."));
        return;
      }
      if (written > options.maxFileSizeBytes) {
        writeStream.destroy();
        entryStream.resume(); // drain the rest so tar-stream can advance to the next entry
        settle({ kind: "too_large", written });
      }
    });

    entryStream.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
    writeStream.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
    writeStream.on("finish", () => settle({ kind: "written", written }));

    entryStream.pipe(writeStream);
  });
}

/**
 * Rejects absolute paths (POSIX or Windows-drive) and any `..` segment,
 * then returns a normalized forward-slash relative path, or `null` if the
 * entry is unsafe (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Safe Extraction"
 * steps 1–2).
 */
function normalizeEntryPath(rawName: string): string | null {
  if (rawName.startsWith("/") || rawName.startsWith("\\") || /^[A-Za-z]:/.test(rawName)) {
    return null;
  }
  const segments = rawName.split(/[/\\]+/).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return null;
  }
  return segments.join("/");
}
