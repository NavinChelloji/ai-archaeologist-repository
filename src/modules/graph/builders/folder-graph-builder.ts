import { basename, computeDegrees, dedupeEdges, dirname, type BuiltGraph, type BuiltNodeSpec } from "./graph-builder-types";

export interface FolderGraphFileInput {
  id: string;
  path: string;
  language: string | null;
}

export function directoryKey(path: string): string {
  return `directory:${path}`;
}

export function fileKey(path: string): string {
  return `file:${path}`;
}

/**
 * Folder graph (GRAPH_SERVICE_PLAN.md "Graph Types": `directory`/`file`
 * nodes, `contains` edges). The root directory is always present (path
 * `""`) so files committed at the repository root have somewhere to attach.
 */
export function buildFolderGraph(files: FolderGraphFileInput[]): BuiltGraph {
  const nodes = new Map<string, BuiltNodeSpec>();
  const edges: BuiltGraph["edges"] = [];

  function ensureDirectory(path: string): string {
    const key = directoryKey(path);
    if (nodes.has(key)) return key;

    nodes.set(key, { nodeType: "directory", label: path === "" ? "/" : basename(path), path, refId: null, metadata: {}, degree: 0 });
    if (path !== "") {
      const parentKey = ensureDirectory(dirname(path));
      edges.push({ sourceKey: parentKey, targetKey: key, edgeType: "contains" });
    }
    return key;
  }

  for (const file of files) {
    const dirKey = ensureDirectory(dirname(file.path));
    const key = fileKey(file.path);
    nodes.set(key, {
      nodeType: "file",
      label: basename(file.path),
      path: file.path,
      refId: file.id,
      metadata: { language: file.language },
      degree: 0,
    });
    edges.push({ sourceKey: dirKey, targetKey: key, edgeType: "contains" });
  }

  const graph = { nodes, edges };
  dedupeEdges(graph);
  computeDegrees(graph);
  return graph;
}
