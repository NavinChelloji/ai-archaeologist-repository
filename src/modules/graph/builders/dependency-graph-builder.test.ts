import { describe, expect, it } from "vitest";
import { buildDependencyGraph, externalPackageKey } from "./dependency-graph-builder";
import { fileKey } from "./folder-graph-builder";

const FILES = [
  { id: "f1", path: "src/app.ts", language: "typescript" },
  { id: "f2", path: "src/utils.ts", language: "typescript" },
];

describe("buildDependencyGraph", () => {
  it("creates a resolved edge between two known files", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: "f2",
        targetPath: "src/utils.ts",
        externalPackage: null,
        rawSpecifier: "./utils",
        importKind: "esm",
        resolutionStatus: "resolved",
      },
    ]);

    expect(graph.edges).toEqual([{ sourceKey: fileKey("src/app.ts"), targetKey: fileKey("src/utils.ts"), edgeType: "imports" }]);
  });

  it("creates an external_package node for an external resolution", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: null,
        targetPath: null,
        externalPackage: "react",
        rawSpecifier: "react",
        importKind: "esm",
        resolutionStatus: "external",
      },
    ]);

    expect(graph.nodes.get(externalPackageKey("react"))).toMatchObject({ nodeType: "external_package", label: "react", metadata: { unresolved: false } });
    expect(graph.edges).toEqual([{ sourceKey: fileKey("src/app.ts"), targetKey: externalPackageKey("react"), edgeType: "imports" }]);
  });

  it("keeps an unresolved import visible as a flagged external_package node instead of dropping it", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: null,
        targetPath: null,
        externalPackage: null,
        rawSpecifier: "./missing",
        importKind: "esm",
        resolutionStatus: "unresolved",
      },
    ]);

    expect(graph.nodes.get(externalPackageKey("./missing"))).toMatchObject({ metadata: { unresolved: true } });
    expect(graph.edges).toHaveLength(1);
  });

  it("keeps a dynamic_unresolvable import visible too, keyed by its raw specifier text", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: null,
        targetPath: null,
        externalPackage: null,
        rawSpecifier: "pathVar",
        importKind: "dynamic",
        resolutionStatus: "dynamic_unresolvable",
      },
    ]);

    expect(graph.nodes.get(externalPackageKey("pathVar"))).toMatchObject({ metadata: { unresolved: true } });
    expect(graph.edges[0]).toMatchObject({ edgeType: "imports_dynamic" });
  });

  it.each([
    ["esm", "imports"],
    ["export_from", "imports"],
    ["type_only", "imports_type"],
    ["require", "requires"],
    ["dynamic", "imports_dynamic"],
  ] as const)("maps import_kind %s to edge_type %s", (importKind, edgeType) => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: "f2",
        targetPath: "src/utils.ts",
        externalPackage: null,
        rawSpecifier: "./utils",
        importKind,
        resolutionStatus: "resolved",
      },
    ]);
    expect(graph.edges[0]).toMatchObject({ edgeType });
  });

  it("collapses two import statements to the same target+kind into a single edge, since graph_edges is unique per (source, target, edge_type)", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "f1",
        targetFileId: "f2",
        targetPath: "src/utils.ts",
        externalPackage: null,
        rawSpecifier: "./utils",
        importKind: "esm",
        resolutionStatus: "resolved",
      },
      {
        sourceFileId: "f1",
        targetFileId: "f2",
        targetPath: "src/utils.ts",
        externalPackage: null,
        rawSpecifier: "./utils",
        importKind: "esm",
        resolutionStatus: "resolved",
      },
    ]);

    expect(graph.edges).toEqual([{ sourceKey: fileKey("src/app.ts"), targetKey: fileKey("src/utils.ts"), edgeType: "imports" }]);
  });

  it("skips an edge whose source file isn't in this snapshot's file set", () => {
    const graph = buildDependencyGraph(FILES, [
      {
        sourceFileId: "unknown-file",
        targetFileId: "f2",
        targetPath: "src/utils.ts",
        externalPackage: null,
        rawSpecifier: "./utils",
        importKind: "esm",
        resolutionStatus: "resolved",
      },
    ]);
    expect(graph.edges).toHaveLength(0);
  });
});
