import type { GraphEdgeType } from "@aca/contracts";
import { basename, computeDegrees, dedupeEdges, type BuiltGraph, type BuiltNodeSpec } from "./graph-builder-types";
import { fileKey } from "./folder-graph-builder";

export interface DependencyGraphFileInput {
  id: string;
  path: string;
  language: string | null;
}

export interface DependencyGraphEdgeInput {
  sourceFileId: string;
  targetFileId: string | null;
  targetPath: string | null;
  externalPackage: string | null;
  rawSpecifier: string;
  importKind: "esm" | "require" | "dynamic" | "export_from" | "type_only";
  resolutionStatus: "resolved" | "external" | "unresolved" | "dynamic_unresolvable";
}

const EDGE_TYPE_BY_IMPORT_KIND: Record<DependencyGraphEdgeInput["importKind"], GraphEdgeType> = {
  esm: "imports",
  export_from: "imports",
  type_only: "imports_type",
  require: "requires",
  dynamic: "imports_dynamic",
};

export function externalPackageKey(label: string): string {
  return `external_package:${label}`;
}

/**
 * Dependency graph (GRAPH_SERVICE_PLAN.md "Graph Types": `file`/
 * `external_package` nodes, `imports`/`imports_type`/`requires`/
 * `imports_dynamic` edges). `unresolved` and `dynamic_unresolvable` edges
 * are deliberately not dropped — the doc's node table has no third node
 * type for "target unknown", so an unresolved import gets an
 * `external_package` node too, labeled with its raw specifier and flagged
 * `unresolved: true` in metadata, keeping it visible rather than silently
 * discarding an edge the parser genuinely found.
 */
export function buildDependencyGraph(files: DependencyGraphFileInput[], dependencies: DependencyGraphEdgeInput[]): BuiltGraph {
  const nodes = new Map<string, BuiltNodeSpec>();
  const edges: BuiltGraph["edges"] = [];
  const fileById = new Map(files.map((f) => [f.id, f]));

  for (const file of files) {
    nodes.set(fileKey(file.path), {
      nodeType: "file",
      label: basename(file.path),
      path: file.path,
      refId: file.id,
      metadata: { language: file.language },
      degree: 0,
    });
  }

  function ensureExternal(label: string, unresolved: boolean): string {
    const key = externalPackageKey(label);
    if (!nodes.has(key)) {
      nodes.set(key, { nodeType: "external_package", label, path: null, refId: null, metadata: { unresolved }, degree: 0 });
    }
    return key;
  }

  for (const dep of dependencies) {
    const sourceFile = fileById.get(dep.sourceFileId);
    if (!sourceFile) continue; // source file was filtered out of this snapshot's inventory
    const sourceKey = fileKey(sourceFile.path);
    const edgeType = EDGE_TYPE_BY_IMPORT_KIND[dep.importKind];

    let targetKey: string;
    if (dep.resolutionStatus === "resolved" && dep.targetPath) {
      targetKey = fileKey(dep.targetPath);
      if (!nodes.has(targetKey)) continue; // resolved to a file outside this file set (shouldn't happen, but never fabricate a node)
    } else if (dep.resolutionStatus === "external" && dep.externalPackage) {
      targetKey = ensureExternal(dep.externalPackage, false);
    } else {
      targetKey = ensureExternal(dep.rawSpecifier, true);
    }

    edges.push({ sourceKey, targetKey, edgeType });
  }

  const graph = { nodes, edges };
  dedupeEdges(graph);
  computeDegrees(graph);
  return graph;
}
