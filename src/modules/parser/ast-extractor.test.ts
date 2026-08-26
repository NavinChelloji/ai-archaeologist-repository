import { describe, expect, it } from "vitest";
import { LANGUAGE_PARSERS, TypeScriptLanguageParser } from "./ast-extractor";

const ts = new TypeScriptLanguageParser("typescript");

describe("TypeScriptLanguageParser symbols", () => {
  it("extracts a top-level exported class with a method and constructor", () => {
    const { symbols } = ts.parse(
      "src/app.ts",
      `export class Widget extends Base {
  constructor(private id: string) {}
  render(): string {
    return this.id;
  }
}
`
    );

    expect(symbols).toHaveLength(3);
    const cls = symbols.find((s) => s.symbolType === "class")!;
    expect(cls).toMatchObject({ name: "Widget", isExported: true, parentIndex: null });
    expect(cls.signature).toContain("extends Base");
    expect(cls.heritage).toEqual({ extendsNames: ["Base"], implementsNames: [] });

    const ctor = symbols.find((s) => s.name === "constructor")!;
    expect(ctor).toMatchObject({ symbolType: "method", qualifiedName: "Widget.constructor" });
    expect(ctor.parentIndex).toBe(symbols.indexOf(cls));

    const method = symbols.find((s) => s.name === "render")!;
    expect(method).toMatchObject({ symbolType: "method", qualifiedName: "Widget.render", signature: "render(): string" });
  });

  it("captures multiple implemented interfaces separately from a single extends clause", () => {
    const { symbols } = ts.parse(
      "src/app.ts",
      `export class Repo extends BaseRepo implements Readable, Writable<string> {}
`
    );
    expect(symbols[0]!.heritage).toEqual({ extendsNames: ["BaseRepo"], implementsNames: ["Readable", "Writable"] });
  });

  it("reports null heritage for non-class/interface symbols", () => {
    const { symbols } = ts.parse("src/app.ts", `export function f() {}\n`);
    expect(symbols[0]!.heritage).toBeNull();
  });

  it("extracts an interface and its method signatures", () => {
    const { symbols } = ts.parse(
      "src/types.ts",
      `export interface Store {
  get(key: string): unknown;
}
`
    );
    expect(symbols.map((s) => s.symbolType)).toEqual(["interface", "method"]);
    expect(symbols[1]).toMatchObject({ name: "get", parentIndex: 0 });
  });

  it("extracts a function declaration with its signature", () => {
    const { symbols } = ts.parse("src/util.ts", `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    expect(symbols).toEqual([
      expect.objectContaining({ symbolType: "function", name: "add", isExported: true, signature: "add(a: number, b: number): number" }),
    ]);
  });

  it("classifies an exported const arrow function as function, and a plain const as variable", () => {
    const { symbols } = ts.parse(
      "src/util.ts",
      `export const double = (x: number): number => x * 2;
export const PI = 3.14;
`
    );
    expect(symbols).toEqual([
      expect.objectContaining({ symbolType: "function", name: "double", isExported: true, signature: "double(x: number): number" }),
      expect.objectContaining({ symbolType: "variable", name: "PI", isExported: true }),
    ]);
  });

  it("still records a non-exported top-level variable, flagged isExported: false", () => {
    const { symbols } = ts.parse("src/util.ts", `const hidden = 1;\n`);
    expect(symbols).toEqual([expect.objectContaining({ symbolType: "variable", name: "hidden", isExported: false })]);
  });

  it("extracts type aliases and enums", () => {
    const { symbols } = ts.parse(
      "src/types.ts",
      `export type Id = string | number;
export enum Color { Red, Green, Blue }
`
    );
    expect(symbols).toEqual([
      expect.objectContaining({ symbolType: "type", name: "Id", signature: "string | number" }),
      expect.objectContaining({ symbolType: "enum", name: "Color" }),
    ]);
  });

  it("reports 1-based line ranges", () => {
    const { symbols } = ts.parse("src/app.ts", `\n\nexport function f() {\n  return 1;\n}\n`);
    expect(symbols[0]).toMatchObject({ startLine: 3, endLine: 5 });
  });

  it("does not descend into function bodies for nested declarations (documented scope trim)", () => {
    const { symbols } = ts.parse(
      "src/app.ts",
      `export function outer() {
  class Inner {}
  return Inner;
}
`
    );
    expect(symbols).toEqual([expect.objectContaining({ name: "outer" })]);
  });
});

describe("TypeScriptLanguageParser imports", () => {
  it("captures a static ESM import", () => {
    const { imports } = ts.parse("src/app.ts", `import { readFile } from "node:fs";\n`);
    expect(imports).toEqual([{ specifier: "node:fs", kind: "esm", isLiteralSpecifier: true, line: 1 }]);
  });

  it("flags a whole-declaration type-only import", () => {
    const { imports } = ts.parse("src/app.ts", `import type { Foo } from "./types";\n`);
    expect(imports[0]).toMatchObject({ specifier: "./types", kind: "type_only" });
  });

  it("captures export ... from as export_from", () => {
    const { imports } = ts.parse("src/index.ts", `export { Foo } from "./foo";\nexport * from "./bar";\n`);
    expect(imports).toEqual([
      { specifier: "./foo", kind: "export_from", isLiteralSpecifier: true, line: 1 },
      { specifier: "./bar", kind: "export_from", isLiteralSpecifier: true, line: 2 },
    ]);
  });

  it("captures a literal require() call", () => {
    const { imports } = ts.parse("src/app.js", `const fs = require("fs");\n`);
    expect(imports).toEqual([{ specifier: "fs", kind: "require", isLiteralSpecifier: true, line: 1 }]);
  });

  it("skips a require() call with a non-literal argument", () => {
    const { imports } = ts.parse("src/app.js", `const name = "fs";\nconst fs = require(name);\n`);
    expect(imports).toEqual([]);
  });

  it("captures a literal dynamic import()", () => {
    const { imports } = ts.parse("src/app.ts", `async function load() {\n  return import("./lazy");\n}\n`);
    expect(imports).toEqual([{ specifier: "./lazy", kind: "dynamic", isLiteralSpecifier: true, line: 2 }]);
  });

  it("records a non-literal dynamic import as unresolvable but still captured", () => {
    const { imports } = ts.parse("src/app.ts", `async function load(path: string) {\n  return import(path);\n}\n`);
    expect(imports).toEqual([{ specifier: "path", kind: "dynamic", isLiteralSpecifier: false, line: 2 }]);
  });

  it("finds imports nested inside function bodies, unlike symbols", () => {
    const { imports } = ts.parse(
      "src/app.ts",
      `export function setup() {
  const fs = require("fs");
  return fs;
}
`
    );
    expect(imports).toEqual([expect.objectContaining({ specifier: "fs", kind: "require" })]);
  });
});

describe("LANGUAGE_PARSERS registry", () => {
  it("registers both typescript and javascript", () => {
    expect(LANGUAGE_PARSERS.get("typescript")).toBeInstanceOf(TypeScriptLanguageParser);
    expect(LANGUAGE_PARSERS.get("javascript")).toBeInstanceOf(TypeScriptLanguageParser);
    expect(LANGUAGE_PARSERS.get("python")).toBeUndefined();
  });

  it("parses .tsx files without syntax errors on JSX", () => {
    const parser = LANGUAGE_PARSERS.get("typescript")!;
    const { symbols } = parser.parse("src/App.tsx", `export function App() {\n  return <div />;\n}\n`);
    expect(symbols).toEqual([expect.objectContaining({ name: "App" })]);
  });
});
