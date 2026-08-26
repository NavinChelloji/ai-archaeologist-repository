import { describe, expect, it } from "vitest";
import { resolvePathAliasCandidates, resolveTsconfigForFile } from "./tsconfig-resolver";

describe("resolveTsconfigForFile", () => {
  it("returns null when no tsconfig.json exists above the file", () => {
    expect(resolveTsconfigForFile("src/app.ts", new Map())).toBeNull();
  });

  it("finds the tsconfig in the same directory as the file", () => {
    const contents = new Map([["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })]]);
    const resolved = resolveTsconfigForFile("src/app.ts", contents);
    expect(resolved).toEqual({ baseUrl: "", paths: { "@/*": ["src/*"] } });
  });

  it("walks up from a nested file to find the nearest tsconfig.json", () => {
    const contents = new Map([
      ["packages/web/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })],
    ]);
    const resolved = resolveTsconfigForFile("packages/web/src/deep/nested/file.ts", contents);
    expect(resolved).toEqual({ baseUrl: "packages/web", paths: { "@/*": ["src/*"] } });
  });

  it("prefers the nearer tsconfig.json over a farther ancestor", () => {
    const contents = new Map([
      ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "root/*": ["x/*"] } } })],
      ["packages/web/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "near/*": ["y/*"] } } })],
    ]);
    const resolved = resolveTsconfigForFile("packages/web/src/app.ts", contents);
    expect(resolved?.paths).toEqual({ "near/*": ["y/*"] });
  });

  it("follows extends when the nearest tsconfig itself declares no paths", () => {
    const contents = new Map([
      ["tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })],
      ["tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } })],
    ]);
    const resolved = resolveTsconfigForFile("src/app.ts", contents);
    expect(resolved).toEqual({ baseUrl: "", paths: { "@/*": ["src/*"] } });
  });

  it("returns null when extends points at a config that isn't in the snapshot", () => {
    const contents = new Map([["tsconfig.json", JSON.stringify({ extends: "./missing-base.json" })]]);
    expect(resolveTsconfigForFile("src/app.ts", contents)).toBeNull();
  });

  it("guards against an extends cycle instead of infinite-looping", () => {
    const contents = new Map([
      ["a.json", JSON.stringify({ extends: "./b.json" })],
      ["b.json", JSON.stringify({ extends: "./a.json" })],
      ["tsconfig.json", JSON.stringify({ extends: "./a.json" })],
    ]);
    expect(resolveTsconfigForFile("src/app.ts", contents)).toBeNull();
  });

  it("tolerates JSONC (comments, trailing commas)", () => {
    const contents = new Map([
      [
        "tsconfig.json",
        `{
          // comment
          "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], } },
        }`,
      ],
    ]);
    expect(resolveTsconfigForFile("src/app.ts", contents)).toEqual({ baseUrl: "", paths: { "@/*": ["src/*"] } });
  });
});

describe("resolvePathAliasCandidates", () => {
  it("matches an exact (non-wildcard) pattern", () => {
    const resolved = { baseUrl: "src", paths: { "config": ["config/index.ts"] } };
    expect(resolvePathAliasCandidates("config", resolved)).toEqual(["src/config/index.ts"]);
  });

  it("substitutes the wildcard match into every target", () => {
    const resolved = { baseUrl: "src", paths: { "@app/*": ["app/*", "legacy/app/*"] } };
    expect(resolvePathAliasCandidates("@app/widgets/button", resolved)).toEqual([
      "src/app/widgets/button",
      "src/legacy/app/widgets/button",
    ]);
  });

  it("returns no candidates when nothing matches", () => {
    const resolved = { baseUrl: "src", paths: { "@app/*": ["app/*"] } };
    expect(resolvePathAliasCandidates("@other/thing", resolved)).toEqual([]);
  });
});
