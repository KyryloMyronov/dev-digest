import { describe, it, expect, afterEach } from "vitest";
import { fileFold, groupFold, resetFolds, setFileFold, setGroupFold } from "./foldStore";
import { storedViewMode, storeViewMode } from "./viewMode";

afterEach(() => {
  resetFolds();
  window.localStorage.clear();
});

describe("foldStore", () => {
  it("remembers a manual fold per PR and per kind", () => {
    setFileFold("pr1", "pnpm-lock.yaml", true);
    setGroupFold("pr1", "boilerplate", true);
    expect(fileFold("pr1", "pnpm-lock.yaml")).toBe(true);
    expect(groupFold("pr1", "boilerplate")).toBe(true);
    // Another PR's diff is untouched — the override is per PR, not global.
    expect(fileFold("pr2", "pnpm-lock.yaml")).toBeUndefined();
    // A file and a group with the same id don't collide.
    expect(groupFold("pr1", "pnpm-lock.yaml")).toBeUndefined();
  });

  it("stores nothing without a PR id", () => {
    setFileFold(null, "a.ts", true);
    expect(fileFold(null, "a.ts")).toBeUndefined();
  });
});

describe("viewMode", () => {
  it("round-trips the per-PR choice and ignores junk", () => {
    expect(storedViewMode("pr1")).toBeNull();
    storeViewMode("pr1", "standard");
    expect(storedViewMode("pr1")).toBe("standard");
    expect(storedViewMode("pr2")).toBeNull();
    window.localStorage.setItem("devdigest:diff-view:pr3", "sideways");
    expect(storedViewMode("pr3")).toBeNull();
  });
});
