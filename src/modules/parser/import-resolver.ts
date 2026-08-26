import { posix } from "node:path";
import { packageEntryCandidate } from "./workspace-packages";
import { resolvePathAliasCandidates, resolveTsconfigForFile } from "./tsconfig-resolver";

/**
 * The resolution algorithm from REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Import
 * Resolution — specified, not improvised":
 *
 *   1. Bare specifier matching a workspace package name -> that package's entry point.
 *   2. Bare specifier otherwise -> external.
 *   3. tsconfig baseUrl+paths aliases (nearest tsconfig, extends followed).
 *   4. Relative path, extension probing: exact, .ts, .tsx, .d.ts, .js, .jsx, .mjs, .cjs.
 *   5. Directory -> index.* with the same extension order.
 *   6. Workspace-internal package.json exports/main.
 *   7. Otherwise -> unresolved.
 *
 * Branches 1-3 only apply to non-relative ("bare") specifiers; branches 4-6
 * only apply once a concrete path is on the table (relative import, or a
 * path already produced by 1/3). The doc lists "otherwise -> external" (2)
 * numerically before tsconfig aliases (3), but aliases are themselves
 * bare-looking specifiers (`@app/utils`, `~/components`) — read literally,
 * step 2 would make step 3 unreachable. This implementation tries the
 * workspace-package match, then the tsconfig alias match, and only declares
 * a bare specifier "external" once neither structural match applies, which
 * is the only reading under which every branch can ever fire.
 * Branch 6 (a directory's own package.json entry point) is folded into
 * directory resolution wherever it happens — branch 1's workspace package
 * root, an alias target, or a plain relative import — rather than as a
 * separate late-only branch, since the doc's intent ("a directory that is
 * itself a package") isn't specific to any one caller.
 */

export type ResolutionStatus = "resolved" | "external" | "unresolved" | "dynamic_unresolvable";
export const RESOLUTION_STATUSES: readonly ResolutionStatus[] = ["resolved", "external", "unresolved", "dynamic_unresolvable"];

export interface ResolvedImport {
  status: ResolutionStatus;
  targetPath: string | null;
  externalPackage: string | null;
}

export interface ResolutionContext {
  /** Every inventoried (post-filter) repo-relative file path in this snapshot — the universe of valid resolution targets. */
  pathSet: ReadonlySet<string>;
  /** Workspace package name -> repo-relative directory. */
  workspacePackages: ReadonlyMap<string, string>;
  /** Every `package.json` in the snapshot, repo-relative path -> raw text. */
  packageJsonContents: ReadonlyMap<string, string>;
  /** Every `tsconfig.json` in the snapshot, repo-relative path -> raw text. */
  tsconfigContents: ReadonlyMap<string, string>;
}

const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

function normalizeRelative(p: string): string {
  const normalized = posix.normalize(p);
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function dirOf(path: string): string {
  return normalizeRelative(posix.dirname(path));
}

function probeFile(basePath: string, ctx: ResolutionContext): string | null {
  if (ctx.pathSet.has(basePath)) return basePath;
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (ctx.pathSet.has(candidate)) return candidate;
  }
  return null;
}

/** Branch 5 and (via `packageEntryCandidate`) branch 6. */
function probeDirectory(dirPath: string, ctx: ResolutionContext): string | null {
  const pkgJsonPath = dirPath === "" ? "package.json" : `${dirPath}/package.json`;
  const pkgContent = ctx.packageJsonContents.get(pkgJsonPath);
  if (pkgContent) {
    const entry = packageEntryCandidate(dirPath, pkgContent);
    const resolved = entry ? probeFile(entry, ctx) : null;
    if (resolved) return resolved;
  }
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = dirPath === "" ? `index${ext}` : `${dirPath}/index${ext}`;
    if (ctx.pathSet.has(candidate)) return candidate;
  }
  return null;
}

function probePathOrDirectory(basePath: string, ctx: ResolutionContext): string | null {
  return probeFile(basePath, ctx) ?? probeDirectory(basePath, ctx);
}

function bareSpecifierPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0]!;
}

function resolveWorkspacePackage(specifier: string, ctx: ResolutionContext): ResolvedImport | null {
  const exactDir = ctx.workspacePackages.get(specifier);
  if (exactDir !== undefined) {
    const resolved = probeDirectory(exactDir, ctx);
    return resolved
      ? { status: "resolved", targetPath: resolved, externalPackage: null }
      : { status: "unresolved", targetPath: null, externalPackage: null };
  }
  for (const [name, dir] of ctx.workspacePackages) {
    if (specifier.startsWith(`${name}/`)) {
      const subpath = specifier.slice(name.length + 1);
      const resolved = probePathOrDirectory(normalizeRelative(posix.join(dir, subpath)), ctx);
      return resolved
        ? { status: "resolved", targetPath: resolved, externalPackage: null }
        : { status: "unresolved", targetPath: null, externalPackage: null };
    }
  }
  return null;
}

function resolveTsconfigAlias(specifier: string, fromFilePath: string, ctx: ResolutionContext): ResolvedImport | null {
  const tsconfig = resolveTsconfigForFile(fromFilePath, ctx.tsconfigContents);
  if (!tsconfig) return null;
  for (const candidateBase of resolvePathAliasCandidates(specifier, tsconfig)) {
    const resolved = probePathOrDirectory(candidateBase, ctx);
    if (resolved) return { status: "resolved", targetPath: resolved, externalPackage: null };
  }
  return null;
}

export function resolveImport(specifier: string, fromFilePath: string, ctx: ResolutionContext): ResolvedImport {
  const isRelative = specifier.startsWith(".");

  if (!isRelative) {
    const viaWorkspace = resolveWorkspacePackage(specifier, ctx);
    if (viaWorkspace) return viaWorkspace;

    const viaAlias = resolveTsconfigAlias(specifier, fromFilePath, ctx);
    if (viaAlias) return viaAlias;

    return { status: "external", targetPath: null, externalPackage: bareSpecifierPackageName(specifier) };
  }

  const basePath = normalizeRelative(posix.join(dirOf(fromFilePath), specifier));
  const resolved = probePathOrDirectory(basePath, ctx);
  return resolved
    ? { status: "resolved", targetPath: resolved, externalPackage: null }
    : { status: "unresolved", targetPath: null, externalPackage: null };
}
