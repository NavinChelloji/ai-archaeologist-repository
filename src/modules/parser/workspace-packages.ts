import { posix } from "node:path";

/**
 * Workspace-package discovery (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Import
 * Resolution" branch 1 and branch 6). Reads only `package.json` and
 * `pnpm-workspace.yaml` as plain text/JSON — never `require`d, never
 * executed (RULES.md).
 */

function normalizeRelative(p: string): string {
  const normalized = posix.normalize(p);
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

export function joinRelative(dir: string, rel: string): string {
  return normalizeRelative(posix.join(dir, rel));
}

/** Minimal parser for pnpm-workspace.yaml's `packages:` list — a flat list of quoted or bare glob strings, one per line. */
function parsePnpmWorkspaceYaml(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) {
      globs.push(match[1]!.replace(/^['"]|['"]$/g, ""));
    } else if (line.trim() !== "") {
      inPackages = false;
    }
  }
  return globs;
}

function parseWorkspaceGlobs(rootPackageJsonText: string | null, pnpmWorkspaceYamlText: string | null): string[] {
  const globs: string[] = [];
  if (rootPackageJsonText) {
    try {
      const pkg = JSON.parse(rootPackageJsonText) as { workspaces?: string[] | { packages?: string[] } };
      if (Array.isArray(pkg.workspaces)) globs.push(...pkg.workspaces);
      else if (pkg.workspaces?.packages) globs.push(...pkg.workspaces.packages);
    } catch {
      // malformed root package.json — no workspace globs from it
    }
  }
  if (pnpmWorkspaceYamlText) {
    globs.push(...parsePnpmWorkspaceYaml(pnpmWorkspaceYamlText));
  }
  return globs;
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      pattern += ".*";
      i += 1;
    } else if (glob[i] === "*") {
      pattern += "[^/]*";
    } else {
      pattern += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(globs: string[], dir: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(dir));
}

/**
 * `packageJsonFiles` is every `package.json` found in the snapshot, keyed by
 * repo-relative path (including the root `"package.json"`, used only to read
 * `workspaces`, never itself registered as a package). Returns package name
 * -> repo-relative directory.
 */
export function discoverWorkspacePackages(
  packageJsonFiles: ReadonlyMap<string, string>,
  pnpmWorkspaceYamlText: string | null
): Map<string, string> {
  const globs = parseWorkspaceGlobs(packageJsonFiles.get("package.json") ?? null, pnpmWorkspaceYamlText);
  const result = new Map<string, string>();
  if (globs.length === 0) return result;

  for (const [path, content] of packageJsonFiles) {
    if (path === "package.json") continue;
    const dir = normalizeRelative(path.slice(0, -"/package.json".length));
    if (!matchesAnyGlob(globs, dir)) continue;
    try {
      const pkg = JSON.parse(content) as { name?: string };
      if (pkg.name) result.set(pkg.name, dir);
    } catch {
      // malformed package.json — not a resolvable workspace package
    }
  }
  return result;
}

function firstStringExportTarget(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object") {
    const record = exportsField as Record<string, unknown>;
    const dot = record["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      for (const key of ["import", "require", "default", "types"]) {
        const value = (dot as Record<string, unknown>)[key];
        if (typeof value === "string") return value;
      }
    }
  }
  return null;
}

/** Branch 6: a directory's own `package.json` `exports`/`main` before falling back to `index.*`. */
export function packageEntryCandidate(dir: string, packageJsonContent: string): string | null {
  try {
    const pkg = JSON.parse(packageJsonContent) as { main?: string; module?: string; exports?: unknown };
    const target = firstStringExportTarget(pkg.exports) ?? pkg.main ?? pkg.module;
    return target ? joinRelative(dir, target) : null;
  } catch {
    return null;
  }
}
