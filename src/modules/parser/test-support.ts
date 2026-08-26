import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import * as tarStream from "tar-stream";

export interface FixtureEntry {
  name: string;
  content?: string;
  size?: number;
  type?: "file" | "symlink" | "link" | "directory";
  linkname?: string;
}

/** Builds an in-memory `.tar.gz` from a small entry list — used by parser module tests instead of a checked-in binary fixture. */
export async function buildTarGz(entries: FixtureEntry[]): Promise<Readable> {
  const pack = tarStream.pack();
  for (const entry of entries) {
    const body = entry.content ?? "";
    await new Promise<void>((resolvePromise, reject) => {
      pack.entry(
        {
          name: entry.name,
          type: entry.type ?? "file",
          size: entry.size ?? Buffer.byteLength(body),
          linkname: entry.linkname,
        },
        entry.type === "symlink" || entry.type === "link" || entry.type === "directory" ? undefined : body,
        (err) => (err ? reject(err) : resolvePromise())
      );
    });
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  const gzip = createGzip();
  pack.pipe(gzip);
  for await (const chunk of gzip) {
    chunks.push(chunk as Buffer);
  }
  return Readable.from(Buffer.concat(chunks));
}
