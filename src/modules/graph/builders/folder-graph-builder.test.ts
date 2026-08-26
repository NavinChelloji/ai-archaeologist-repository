import { describe, expect, it } from "vitest";
import { buildFolderGraph, directoryKey, fileKey } from "./folder-graph-builder";

describe("buildFolderGraph", () => {
  it("attaches a root-level file directly to the root directory", () => {
    const graph = buildFolderGraph([{ id: "f1", path: "README.md", language: "markdown" }]);

    expect(graph.nodes.get(directoryKey(""))).toMatchObject({ nodeType: "directory", label: "/", path: "" });
    expect(graph.nodes.get(fileKey("README.md"))).toMatchObject({ nodeType: "file", label: "README.md", refId: "f1" });
    expect(graph.edges).toEqual([{ sourceKey: directoryKey(""), targetKey: fileKey("README.md"), edgeType: "contains" }]);
  });

  it("builds intermediate directories for deep nesting without duplicating them", () => {
    const graph = buildFolderGraph([
      { id: "f1", path: "src/a/b/c/deep.ts", language: "typescript" },
      { id: "f2", path: "src/a/other.ts", language: "typescript" },
    ]);

    expect([...graph.nodes.keys()].filter((k) => k.startsWith("directory:")).sort()).toEqual(
      ["directory:", "directory:src", "directory:src/a", "directory:src/a/b", "directory:src/a/b/c"].sort()
    );
    // src/a is only created once despite being an ancestor of both files.
    expect(graph.edges.filter((e) => e.targetKey === directoryKey("src/a"))).toHaveLength(1);
  });

  it("computes degree as in-degree plus out-degree", () => {
    const graph = buildFolderGraph([{ id: "f1", path: "src/app.ts", language: "typescript" }]);

    // root -> src (1 out), src -> app.ts (1 in + 1 out = 2), app.ts (1 in)
    expect(graph.nodes.get(directoryKey(""))!.degree).toBe(1);
    expect(graph.nodes.get(directoryKey("src"))!.degree).toBe(2);
    expect(graph.nodes.get(fileKey("src/app.ts"))!.degree).toBe(1);
  });

  it("returns an empty graph for no files", () => {
    const graph = buildFolderGraph([]);
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });
});
