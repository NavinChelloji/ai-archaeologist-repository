import { describe, expect, it } from "vitest";
import { resolveImport, type ResolutionContext } from "./import-resolver";

function ctx(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    pathSet: new Set(),
    workspacePackages: new Map(),
    packageJsonContents: new Map(),
    tsconfigContents: new Map(),
    ...overrides,
  };
}

describe("resolveImport — relative specifiers (branches 4/5/6)", () => {
  it("resolves an exact match", () => {
    const context = ctx({ pathSet: new Set(["src/utils.ts"]) });
    expect(resolveImport("./utils.ts", "src/app.ts", context)).toEqual({ status: "resolved", targetPath: "src/utils.ts", externalPackage: null });
  });

  it("probes extensions in the documented order", () => {
    const context = ctx({ pathSet: new Set(["src/utils.tsx"]) });
    expect(resolveImport("./utils", "src/app.ts", context)).toEqual({ status: "resolved", targetPath: "src/utils.tsx", externalPackage: null });
  });

  it("resolves a directory to its index file", () => {
    const context = ctx({ pathSet: new Set(["src/widgets/index.ts"]) });
    expect(resolveImport("./widgets", "src/app.ts", context)).toEqual({
      status: "resolved",
      targetPath: "src/widgets/index.ts",
      externalPackage: null,
    });
  });

  it("prefers a directory's own package.json main over index.*", () => {
    const context = ctx({
      pathSet: new Set(["src/widgets/lib.ts", "src/widgets/index.ts"]),
      packageJsonContents: new Map([["src/widgets/package.json", JSON.stringify({ main: "lib.ts" })]]),
    });
    expect(resolveImport("./widgets", "src/app.ts", context)).toEqual({
      status: "resolved",
      targetPath: "src/widgets/lib.ts",
      externalPackage: null,
    });
  });

  it("resolves .. correctly against the importing file's directory", () => {
    const context = ctx({ pathSet: new Set(["src/utils.ts"]) });
    expect(resolveImport("../utils", "src/nested/deep.ts", context)).toEqual({
      status: "resolved",
      targetPath: "src/utils.ts",
      externalPackage: null,
    });
  });

  it("reports unresolved when nothing on disk matches", () => {
    const context = ctx({ pathSet: new Set(["src/other.ts"]) });
    expect(resolveImport("./missing", "src/app.ts", context)).toEqual({ status: "unresolved", targetPath: null, externalPackage: null });
  });
});

describe("resolveImport — bare specifiers (branches 1/2/3)", () => {
  it("resolves a workspace package by exact name to its entry point", () => {
    const context = ctx({
      pathSet: new Set(["packages/utils/src/index.ts"]),
      workspacePackages: new Map([["@aca/utils", "packages/utils"]]),
      packageJsonContents: new Map([["packages/utils/package.json", JSON.stringify({ main: "src/index.ts" })]]),
    });
    expect(resolveImport("@aca/utils", "src/app.ts", context)).toEqual({
      status: "resolved",
      targetPath: "packages/utils/src/index.ts",
      externalPackage: null,
    });
  });

  it("resolves a workspace package sub-path import", () => {
    const context = ctx({
      pathSet: new Set(["packages/utils/src/math.ts"]),
      workspacePackages: new Map([["@aca/utils", "packages/utils"]]),
    });
    expect(resolveImport("@aca/utils/src/math", "src/app.ts", context)).toEqual({
      status: "resolved",
      targetPath: "packages/utils/src/math.ts",
      externalPackage: null,
    });
  });

  it("treats an unknown bare specifier as external, using the scoped package name", () => {
    const context = ctx();
    expect(resolveImport("@scope/pkg/deep/path", "src/app.ts", context)).toEqual({
      status: "external",
      targetPath: null,
      externalPackage: "@scope/pkg",
    });
  });

  it("treats an unscoped bare specifier as external", () => {
    const context = ctx();
    expect(resolveImport("lodash/fp", "src/app.ts", context)).toEqual({ status: "external", targetPath: null, externalPackage: "lodash" });
  });

  it("resolves a bare specifier via a tsconfig path alias before falling to external", () => {
    const context = ctx({
      pathSet: new Set(["src/components/Button.tsx"]),
      tsconfigContents: new Map([
        [
          "tsconfig.json",
          JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
        ],
      ]),
    });
    expect(resolveImport("@app/components/Button", "src/index.ts", context)).toEqual({
      status: "resolved",
      targetPath: "src/components/Button.tsx",
      externalPackage: null,
    });
  });

  it("falls back to external when a tsconfig alias pattern doesn't match any real file", () => {
    const context = ctx({
      tsconfigContents: new Map([["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } })]]),
    });
    expect(resolveImport("@app/missing", "src/index.ts", context)).toEqual({
      status: "external",
      targetPath: null,
      externalPackage: "@app/missing",
    });
  });

  it("follows the nearest tsconfig's extends chain, resolving baseUrl against the declaring config's own directory (not the nearest one)", () => {
    const context = ctx({
      // Repo-root relative, matching tsconfig.base.json's own directory ("") as baseUrl — not "packages/web".
      pathSet: new Set(["src/shared/Icon.tsx"]),
      tsconfigContents: new Map([
        ["tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } })],
        ["packages/web/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.base.json" })],
      ]),
    });
    expect(resolveImport("~/shared/Icon", "packages/web/src/app.tsx", context)).toEqual({
      status: "resolved",
      targetPath: "src/shared/Icon.tsx",
      externalPackage: null,
    });
  });

  it("stops following extends when it points at an uninstalled package (no node_modules), leaving the specifier external", () => {
    const context = ctx({
      tsconfigContents: new Map([["tsconfig.json", JSON.stringify({ extends: "@tsconfig/node18" })]]),
    });
    expect(resolveImport("@app/anything", "src/app.ts", context)).toEqual({
      status: "external",
      targetPath: null,
      externalPackage: "@app/anything",
    });
  });
});
