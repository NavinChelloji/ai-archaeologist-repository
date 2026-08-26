import { basename, computeDegrees, dedupeEdges, type BuiltGraph, type BuiltNodeSpec } from "./graph-builder-types";
import { fileKey } from "./folder-graph-builder";

export interface SymbolGraphFileInput {
  id: string;
  path: string;
}

export type AllSymbolTypes = "class" | "interface" | "function" | "method" | "type" | "enum" | "variable";
type SymbolGraphNodeType = Exclude<AllSymbolTypes, "variable">;

export interface SymbolGraphSymbolInput {
  id: string;
  fileId: string;
  parentSymbolId: string | null;
  symbolType: AllSymbolTypes;
  name: string;
  qualifiedName: string | null;
  isExported: boolean;
  /** `{ extends?: string[]; implements?: string[] }` for class/interface — see ast-extractor.ts's RawHeritage, persisted in code_symbols.metadata by Stage 6. */
  metadata: Record<string, unknown>;
}

const SYMBOL_GRAPH_NODE_TYPES: ReadonlySet<AllSymbolTypes> = new Set<SymbolGraphNodeType>([
  "class",
  "interface",
  "function",
  "method",
  "type",
  "enum",
]);

function isSymbolGraphNodeType(t: AllSymbolTypes): t is SymbolGraphNodeType {
  return SYMBOL_GRAPH_NODE_TYPES.has(t);
}

export function symbolKey(symbolId: string): string {
  return `symbol:${symbolId}`;
}

function heritageNames(metadata: Record<string, unknown>, key: "extends" | "implements"): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Symbol graph (GRAPH_SERVICE_PLAN.md "Graph Types": `class`/`interface`/
 * `function`/`method`/`type`/`enum` nodes — `variable` is explicitly
 * excluded — `declares`/`extends`/`implements`/`member_of` edges).
 *
 * Two relationships share the underlying `parent_symbol_id` containment
 * fact but are kept as distinct edge types rather than one bidirectional
 * pair (which the reverse index already makes redundant): `declares` is
 * file -> top-level symbol; `member_of` is method -> its class/interface.
 * A `file` node is added pragmatically (the doc's node-type table omits it,
 * but every top-level symbol needs somewhere to attach `declares` from, or
 * it renders as a disconnected island).
 *
 * `extends`/`implements` targets are resolved by exact name match against
 * class/interface symbols anywhere in the snapshot (not import-path
 * verified — Stage 6 doesn't correlate heritage clauses with resolved
 * imports). An ambiguous name (two classes sharing it) is skipped rather
 * than guessed.
 */
export function buildSymbolGraph(files: SymbolGraphFileInput[], symbols: SymbolGraphSymbolInput[]): BuiltGraph {
  const nodes = new Map<string, BuiltNodeSpec>();
  const edges: BuiltGraph["edges"] = [];
  const fileById = new Map(files.map((f) => [f.id, f]));

  const included = symbols.filter((s): s is SymbolGraphSymbolInput & { symbolType: SymbolGraphNodeType } =>
    isSymbolGraphNodeType(s.symbolType)
  );
  const includedById = new Map(included.map((s) => [s.id, s]));

  const byName = new Map<string, SymbolGraphSymbolInput[]>();
  for (const s of included) {
    if (s.symbolType !== "class" && s.symbolType !== "interface") continue;
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }

  const fileNodesAdded = new Set<string>();
  function ensureFileNode(fileId: string): string | null {
    const file = fileById.get(fileId);
    if (!file) return null;
    const key = fileKey(file.path);
    if (!fileNodesAdded.has(fileId)) {
      fileNodesAdded.add(fileId);
      nodes.set(key, { nodeType: "file", label: basename(file.path), path: file.path, refId: file.id, metadata: {}, degree: 0 });
    }
    return key;
  }

  function resolveHeritageTarget(name: string): SymbolGraphSymbolInput | null {
    const candidates = byName.get(name);
    return candidates && candidates.length === 1 ? candidates[0]! : null;
  }

  for (const symbol of included) {
    const key = symbolKey(symbol.id);
    nodes.set(key, {
      nodeType: symbol.symbolType,
      label: symbol.name,
      path: fileById.get(symbol.fileId)?.path ?? null,
      refId: symbol.id,
      metadata: { qualifiedName: symbol.qualifiedName, isExported: symbol.isExported },
      degree: 0,
    });
  }

  for (const symbol of included) {
    const key = symbolKey(symbol.id);

    if (symbol.parentSymbolId && includedById.has(symbol.parentSymbolId)) {
      edges.push({ sourceKey: key, targetKey: symbolKey(symbol.parentSymbolId), edgeType: "member_of" });
    } else if (!symbol.parentSymbolId) {
      const fileNodeKey = ensureFileNode(symbol.fileId);
      if (fileNodeKey) edges.push({ sourceKey: fileNodeKey, targetKey: key, edgeType: "declares" });
    }

    if (symbol.symbolType !== "class" && symbol.symbolType !== "interface") continue;
    for (const name of heritageNames(symbol.metadata, "extends")) {
      const target = resolveHeritageTarget(name);
      if (target) edges.push({ sourceKey: key, targetKey: symbolKey(target.id), edgeType: "extends" });
    }
    for (const name of heritageNames(symbol.metadata, "implements")) {
      const target = resolveHeritageTarget(name);
      if (target) edges.push({ sourceKey: key, targetKey: symbolKey(target.id), edgeType: "implements" });
    }
  }

  const graph = { nodes, edges };
  dedupeEdges(graph);
  computeDegrees(graph);
  return graph;
}
