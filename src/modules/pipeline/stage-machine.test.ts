import { describe, expect, it } from "vitest";
import {
  buildProgressMessage,
  interpolateProgress,
  isValidTransition,
  nextStage,
  stageEntryProgress,
} from "./stage-machine";

describe("nextStage", () => {
  it("walks the documented chain in order", () => {
    expect(nextStage("queued")).toBe("snapshotting");
    expect(nextStage("snapshotting")).toBe("extracting");
    expect(nextStage("extracting")).toBe("parsing");
    expect(nextStage("parsing")).toBe("graphing");
    expect(nextStage("graphing")).toBe("embedding");
    expect(nextStage("embedding")).toBe("completed");
  });

  it("throws for a terminal stage with nothing after it", () => {
    expect(() => nextStage("completed")).toThrow();
    expect(() => nextStage("failed")).toThrow();
  });
});

describe("isValidTransition", () => {
  it("allows forward progression along the chain", () => {
    expect(isValidTransition("snapshotting", "extracting")).toBe(true);
    expect(isValidTransition("snapshotting", "parsing")).toBe(false);
  });

  it("allows failed/cancelled from any non-terminal stage", () => {
    expect(isValidTransition("parsing", "failed")).toBe(true);
    expect(isValidTransition("embedding", "cancelled")).toBe(true);
  });

  it("rejects failed/cancelled from an already-terminal stage", () => {
    expect(isValidTransition("completed", "failed")).toBe(false);
    expect(isValidTransition("failed", "cancelled")).toBe(false);
  });
});

describe("interpolateProgress", () => {
  it("substantiates a percentage from itemsProcessed/totalItems within the stage's range", () => {
    expect(interpolateProgress("parsing", 0, 100)).toBe(30);
    expect(interpolateProgress("parsing", 50, 100)).toBe(45);
    expect(interpolateProgress("parsing", 100, 100)).toBe(60);
  });

  it("falls back to the stage minimum when totalItems is not yet known", () => {
    expect(interpolateProgress("embedding", 0, 0)).toBe(75);
  });

  it("clamps out-of-range fractions", () => {
    expect(interpolateProgress("snapshotting", 200, 100)).toBe(10);
  });
});

describe("stageEntryProgress", () => {
  it("matches the fixed lower bound of each stage's range", () => {
    expect(stageEntryProgress("snapshotting")).toBe(0);
    expect(stageEntryProgress("graphing")).toBe(60);
    expect(stageEntryProgress("completed")).toBe(100);
  });
});

describe("buildProgressMessage", () => {
  it("includes counts when both are known", () => {
    expect(buildProgressMessage("parsing", 812, 1940)).toBe("Parsing symbols and imports: 812 of 1,940");
  });

  it("falls back to a plain stage label otherwise", () => {
    expect(buildProgressMessage("graphing")).toBe("Building graphs");
  });
});
