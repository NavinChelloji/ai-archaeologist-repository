import { posix } from "node:path";
import ts from "typescript";

/**
 * `tsconfig.json` `baseUrl`/`paths` alias resolution
 * (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Import Resolution" branch 3). Read
 * as JSON (JSONC via the TypeScript parser, never `require`d) — RULES.md
 * "never evaluate config files".
 */

export interface ResolvedTsconfig {
  /** Repo-relative directory that declared `paths` — `baseUrl` in an extended config resolves relative to *that* config's own directory, not the importing file's tsconfig. */
  baseUrl: string;
  paths: Record<string, string[]>;
}

function normalizeRelative(p: string): string {
  const normalized = posix.normalize(p);
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function dirOf(path: string): string {
  return normalizeRelative(posix.dirname(path));
}

function findNearestTsconfig(filePath: string, tsconfigPaths: ReadonlySet<string>): string | null {
  let dir = dirOf(filePath);
  for (;;) {
    const candidate = dir === "" ? "tsconfig.json" : `${dir}/tsconfig.json`;
    if (tsconfigPaths.has(candidate)) return candidate;
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

function resolveExtendsPath(fromDir: string, extendsSpec: string, tsconfigContents: ReadonlyMap<string, string>): string | null {
  if (!extendsSpec.startsWith(".")) return null; // bare package extends (e.g. "@tsconfig/node18") — not installed, can't follow
  let candidate = normalizeRelative(posix.join(fromDir, extendsSpec));
  if (!candidate.endsWith(".json")) candidate += ".json";
  return tsconfigContents.has(candidate) ? candidate : null;
}

function loadJsonc(path: string, text: string): Record<string, unknown> | null {
  const result = ts.parseConfigFileTextToJson(path, text);
  if (result.error || typeof result.config !== "object" || result.config === null) return null;
  return result.config as Record<string, unknown>;
}

function resolveChain(configPath: string, tsconfigContents: ReadonlyMap<string, string>, seen: Set<string>): ResolvedTsconfig | null {
  if (seen.has(configPath)) return null; // extends cycle guard
  seen.add(configPath);

  const text = tsconfigContents.get(configPath);
  if (!text) return null;
  const json = loadJsonc(configPath, text);
  if (!json) return null;

  const configDir = dirOf(configPath);
  const compilerOptions = json.compilerOptions;
  if (compilerOptions && typeof compilerOptions === "object") {
    const { paths, baseUrl } = compilerOptions as { paths?: unknown; baseUrl?: unknown };
    if (paths && typeof paths === "object") {
      const resolvedBaseUrl = typeof baseUrl === "string" ? normalizeRelative(posix.join(configDir, baseUrl)) : configDir;
      return { baseUrl: resolvedBaseUrl, paths: paths as Record<string, string[]> };
    }
  }

  const extendsField = json.extends;
  if (typeof extendsField === "string") {
    const extendedPath = resolveExtendsPath(configDir, extendsField, tsconfigContents);
    if (extendedPath) return resolveChain(extendedPath, tsconfigContents, seen);
  }
  return null;
}

/** Finds the nearest `tsconfig.json` above `filePath` (walking up directories) and follows its `extends` chain until one declares `paths`. */
export function resolveTsconfigForFile(filePath: string, tsconfigContents: ReadonlyMap<string, string>): ResolvedTsconfig | null {
  const nearest = findNearestTsconfig(filePath, new Set(tsconfigContents.keys()));
  if (!nearest) return null;
  return resolveChain(nearest, tsconfigContents, new Set());
}

/** Returns repo-relative candidate paths (no extension probing applied yet) for a bare specifier against a resolved `paths` map, in declaration order. */
export function resolvePathAliasCandidates(specifier: string, resolved: ResolvedTsconfig): string[] {
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(resolved.paths)) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      if (pattern === specifier) {
        for (const target of targets) candidates.push(normalizeRelative(posix.join(resolved.baseUrl, target)));
      }
      continue;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const target of targets) {
        candidates.push(normalizeRelative(posix.join(resolved.baseUrl, target.replace("*", matched))));
      }
    }
  }
  return candidates;
}
