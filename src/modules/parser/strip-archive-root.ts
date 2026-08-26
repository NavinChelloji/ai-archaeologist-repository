/**
 * GitHub's tarball endpoint always wraps every entry in one generated
 * top-level directory (`{owner}-{repo}-{sha}/...`) that isn't part of the
 * repository's own structure. Strips it so `repository_files.path` reads
 * `src/app.ts`, not `octocat-hello-world-abc123/src/app.ts`.
 *
 * Only strips when every given path actually shares the same first
 * segment — an archive that doesn't (a hand-built test fixture, or a
 * malformed upload) is left as-is rather than guessing.
 */
export function stripArchiveRootPrefix(paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const firstSegments = new Set(paths.map((path) => path.split("/")[0]));
  const hasCommonRoot = firstSegments.size === 1 && paths.every((path) => path.includes("/"));

  for (const path of paths) {
    result.set(path, hasCommonRoot ? path.slice(path.indexOf("/") + 1) : path);
  }
  return result;
}
