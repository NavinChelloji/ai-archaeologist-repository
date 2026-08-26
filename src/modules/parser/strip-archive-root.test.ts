import { describe, expect, it } from "vitest";
import { stripArchiveRootPrefix } from "./strip-archive-root";

describe("stripArchiveRootPrefix", () => {
  it("strips a shared top-level wrapper directory", () => {
    const result = stripArchiveRootPrefix(["octocat-repo-abc123/src/app.ts", "octocat-repo-abc123/README.md"]);

    expect(result.get("octocat-repo-abc123/src/app.ts")).toBe("src/app.ts");
    expect(result.get("octocat-repo-abc123/README.md")).toBe("README.md");
  });

  it("leaves paths as-is when there is no single shared top-level directory", () => {
    const result = stripArchiveRootPrefix(["a/one.ts", "b/two.ts"]);

    expect(result.get("a/one.ts")).toBe("a/one.ts");
    expect(result.get("b/two.ts")).toBe("b/two.ts");
  });

  it("leaves paths as-is when an entry has no directory component at all", () => {
    const result = stripArchiveRootPrefix(["top-level-file.txt"]);

    expect(result.get("top-level-file.txt")).toBe("top-level-file.txt");
  });

  it("returns an empty map for an empty input", () => {
    expect(stripArchiveRootPrefix([]).size).toBe(0);
  });
});
