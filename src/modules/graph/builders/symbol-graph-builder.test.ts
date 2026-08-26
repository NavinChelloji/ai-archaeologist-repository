import { describe, expect, it } from "vitest";
import { buildSymbolGraph, symbolKey } from "./symbol-graph-builder";
import { fileKey } from "./folder-graph-builder";

const FILES = [{ id: "f1", path: "src/app.ts" }];

describe("buildSymbolGraph", () => {
  it("excludes variable symbols from the node set entirely", () => {
    const graph = buildSymbolGraph(FILES, [
      { id: "s1", fileId: "f1", parentSymbolId: null, symbolType: "variable", name: "x", qualifiedName: "x", isExported: true, metadata: {} },
    ]);
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("declares a top-level function from its file", () => {
    const graph = buildSymbolGraph(FILES, [
      { id: "s1", fileId: "f1", parentSymbolId: null, symbolType: "function", name: "run", qualifiedName: "run", isExported: true, metadata: {} },
    ]);

    expect(graph.nodes.get(fileKey("src/app.ts"))).toMatchObject({ nodeType: "file" });
    expect(graph.nodes.get(symbolKey("s1"))).toMatchObject({ nodeType: "function", label: "run" });
    expect(graph.edges).toEqual([{ sourceKey: fileKey("src/app.ts"), targetKey: symbolKey("s1"), edgeType: "declares" }]);
  });

  it("links a method to its class via member_of, not declares", () => {
    const graph = buildSymbolGraph(FILES, [
      { id: "cls", fileId: "f1", parentSymbolId: null, symbolType: "class", name: "Widget", qualifiedName: "Widget", isExported: true, metadata: {} },
      {
        id: "m1",
        fileId: "f1",
        parentSymbolId: "cls",
        symbolType: "method",
        name: "render",
        qualifiedName: "Widget.render",
        isExported: false,
        metadata: {},
      },
    ]);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { sourceKey: fileKey("src/app.ts"), targetKey: symbolKey("cls"), edgeType: "declares" },
        { sourceKey: symbolKey("m1"), targetKey: symbolKey("cls"), edgeType: "member_of" },
      ])
    );
    expect(graph.edges).toHaveLength(2);
  });

  it("resolves extends and implements to sibling class/interface symbols by name", () => {
    const graph = buildSymbolGraph(FILES, [
      { id: "base", fileId: "f1", parentSymbolId: null, symbolType: "class", name: "Base", qualifiedName: "Base", isExported: true, metadata: {} },
      { id: "iface", fileId: "f1", parentSymbolId: null, symbolType: "interface", name: "Readable", qualifiedName: "Readable", isExported: true, metadata: {} },
      {
        id: "widget",
        fileId: "f1",
        parentSymbolId: null,
        symbolType: "class",
        name: "Widget",
        qualifiedName: "Widget",
        isExported: true,
        metadata: { extends: ["Base"], implements: ["Readable"] },
      },
    ]);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { sourceKey: symbolKey("widget"), targetKey: symbolKey("base"), edgeType: "extends" },
        { sourceKey: symbolKey("widget"), targetKey: symbolKey("iface"), edgeType: "implements" },
      ])
    );
  });

  it("skips a heritage name that doesn't match any symbol in the snapshot", () => {
    const graph = buildSymbolGraph(FILES, [
      {
        id: "widget",
        fileId: "f1",
        parentSymbolId: null,
        symbolType: "class",
        name: "Widget",
        qualifiedName: "Widget",
        isExported: true,
        metadata: { extends: ["NotDeclaredAnywhere"] },
      },
    ]);
    expect(graph.edges.filter((e) => e.edgeType === "extends")).toHaveLength(0);
  });

  it("skips an ambiguous heritage name shared by two symbols rather than guessing", () => {
    const graph = buildSymbolGraph(
      [
        { id: "f1", path: "src/a.ts" },
        { id: "f2", path: "src/b.ts" },
      ],
      [
        { id: "base1", fileId: "f1", parentSymbolId: null, symbolType: "class", name: "Base", qualifiedName: "Base", isExported: true, metadata: {} },
        { id: "base2", fileId: "f2", parentSymbolId: null, symbolType: "class", name: "Base", qualifiedName: "Base", isExported: true, metadata: {} },
        {
          id: "widget",
          fileId: "f1",
          parentSymbolId: null,
          symbolType: "class",
          name: "Widget",
          qualifiedName: "Widget",
          isExported: true,
          metadata: { extends: ["Base"] },
        },
      ]
    );
    expect(graph.edges.filter((e) => e.edgeType === "extends")).toHaveLength(0);
  });
});
