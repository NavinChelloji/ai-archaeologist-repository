import { describe, expect, it } from "vitest";
import { discoverWorkspacePackages, packageEntryCandidate } from "./workspace-packages";

describe("discoverWorkspacePackages", () => {
  it("discovers packages matching npm/yarn workspaces globs", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
      ["packages/utils/package.json", JSON.stringify({ name: "@aca/utils" })],
      ["packages/web/package.json", JSON.stringify({ name: "@aca/web" })],
      ["apps/cli/package.json", JSON.stringify({ name: "@aca/cli" })], // not matched by "packages/*"
    ]);

    const result = discoverWorkspacePackages(files, null);
    expect(result).toEqual(new Map([["@aca/utils", "packages/utils"], ["@aca/web", "packages/web"]]));
  });

  it("discovers packages matching the { workspaces: { packages: [...] } } object form", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ workspaces: { packages: ["services/*"] } })],
      ["services/auth/package.json", JSON.stringify({ name: "@aca/auth" })],
    ]);
    expect(discoverWorkspacePackages(files, null)).toEqual(new Map([["@aca/auth", "services/auth"]]));
  });

  it("parses pnpm-workspace.yaml's packages list", () => {
    const files = new Map([["packages/contracts/package.json", JSON.stringify({ name: "@aca/contracts" })]]);
    const yaml = "packages:\n  - 'packages/*'\n  - 'apps/*'\n";
    expect(discoverWorkspacePackages(files, yaml)).toEqual(new Map([["@aca/contracts", "packages/contracts"]]));
  });

  it("supports ** for arbitrary depth", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ workspaces: ["packages/**"] })],
      ["packages/a/b/package.json", JSON.stringify({ name: "deep-pkg" })],
    ]);
    expect(discoverWorkspacePackages(files, null)).toEqual(new Map([["deep-pkg", "packages/a/b"]]));
  });

  it("returns empty when there are no workspace globs at all", () => {
    const files = new Map([["packages/utils/package.json", JSON.stringify({ name: "@aca/utils" })]]);
    expect(discoverWorkspacePackages(files, null)).toEqual(new Map());
  });

  it("ignores a malformed package.json rather than throwing", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
      ["packages/broken/package.json", "{ not json"],
    ]);
    expect(discoverWorkspacePackages(files, null)).toEqual(new Map());
  });

  it("skips a matched package.json with no name field", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ workspaces: ["packages/*"] })],
      ["packages/anon/package.json", JSON.stringify({ version: "1.0.0" })],
    ]);
    expect(discoverWorkspacePackages(files, null)).toEqual(new Map());
  });
});

describe("packageEntryCandidate", () => {
  it("prefers exports['.'] over main", () => {
    const pkg = JSON.stringify({ main: "dist/index.js", exports: { ".": "src/index.ts" } });
    expect(packageEntryCandidate("packages/utils", pkg)).toBe("packages/utils/src/index.ts");
  });

  it("falls back to main when exports has no '.' entry", () => {
    const pkg = JSON.stringify({ main: "dist/index.js", exports: { "./sub": "./src/sub.ts" } });
    expect(packageEntryCandidate("packages/utils", pkg)).toBe("packages/utils/dist/index.js");
  });

  it("resolves a conditional exports['.'] object via import/require/default", () => {
    const pkg = JSON.stringify({ exports: { ".": { types: "./dist/index.d.ts", import: "./src/index.ts" } } });
    expect(packageEntryCandidate("packages/utils", pkg)).toBe("packages/utils/src/index.ts");
  });

  it("returns null when neither exports nor main is present", () => {
    expect(packageEntryCandidate("packages/utils", JSON.stringify({ name: "x" }))).toBeNull();
  });

  it("returns null for malformed package.json", () => {
    expect(packageEntryCandidate("packages/utils", "{ broken")).toBeNull();
  });
});
