import { describe, it, expect } from "vitest";
import type { FindingRecord, ReviewRecord } from "@devdigest/shared";
import type { PrFile, SmartDiff } from "@/lib/types";
import {
  buildAnnotations,
  currentFindings,
  diffLineIndex,
  findingInDiff,
  resolveGroups,
  withFoldOverrides,
  withRoleTags,
} from "./helpers";

/**
 * The join between the three payloads the Files tab reads. What matters here is
 * what happens when they disagree — the smart diff and the detail are separate
 * requests, so a path in one and not the other is a normal race, not a bug —
 * and that the open/closed default encodes the roles rather than file size.
 */

const file = (path: string, additions = 5): PrFile => ({
  path,
  additions,
  deletions: 0,
  patch: null,
});

const smartFile = (path: string, finding_lines: number[] = []) => ({
  path,
  additions: 5,
  deletions: 0,
  finding_lines,
});

const SMART: SmartDiff = {
  groups: [
    { role: "core", files: [smartFile("src/a.ts", [4, 5]), smartFile("src/b.ts")] },
    { role: "boilerplate", files: [smartFile("pnpm-lock.yaml")] },
  ],
  split_suggestion: { too_big: false, total_lines: 15, proposed_splits: [] },
};

const finding = (over: Partial<FindingRecord>): FindingRecord => ({
  id: "f1",
  severity: "WARNING",
  category: "bug",
  title: "a finding",
  file: "src/a.ts",
  start_line: 4,
  end_line: 5,
  rationale: "because",
  suggestion: null,
  confidence: 0.9,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
  ...over,
});

describe("resolveGroups", () => {
  it("resolves each group's paths back to the files that carry the patch", () => {
    const groups = resolveGroups(SMART, [
      file("src/a.ts", 10),
      file("src/b.ts", 2),
      file("pnpm-lock.yaml", 900),
    ]);
    expect(groups.map((g) => g.role)).toEqual(["core", "boilerplate"]);
    expect(groups[0]!.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groups[0]!.lines).toBe(12);
    expect(groups[0]!.findingLines).toBe(2);
  });

  it("drops a path the PR detail doesn't know, and the group with it", () => {
    // Two separate requests: a PR that gains a commit between them can name a
    // file the detail hasn't got. Better absent than an empty diff card.
    const groups = resolveGroups(SMART, [file("src/a.ts")]);
    expect(groups.map((g) => g.role)).toEqual(["core"]);
    expect(groups[0]!.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});

const review = (over: Partial<ReviewRecord>): ReviewRecord => ({
  id: "r1",
  pr_id: "pr1",
  agent_id: "general",
  run_id: "run1",
  agent_name: "General",
  kind: "review",
  verdict: "comment",
  summary: "s",
  score: 61,
  model: "seed",
  created_at: "2026-08-18T12:00:00.000Z",
  findings: [finding({})],
  ...over,
});

describe("currentFindings", () => {
  it("drops an agent's superseded review", () => {
    const found = currentFindings([
      review({ id: "r2", created_at: "2026-08-18T13:00:00.000Z", findings: [finding({ id: "new" })] }),
      review({ id: "r1", created_at: "2026-08-18T12:00:00.000Z", findings: [finding({ id: "old" })] }),
    ]);
    expect(found.map((f) => f.id)).toEqual(["new"]);
  });

  it("keeps one review per agent when a run fans out to several", () => {
    // Same timestamp, different agents: `all: true` writes these together, and
    // taking the newest ROW would keep one and silently drop the other.
    const found = currentFindings([
      review({ id: "r1", agent_id: "general", findings: [finding({ id: "g" })] }),
      review({ id: "r2", agent_id: "security", findings: [finding({ id: "s" })] }),
    ]);
    expect(found.map((f) => f.id).sort()).toEqual(["g", "s"]);
  });

  it("treats agent-less reviews as one bucket", () => {
    const found = currentFindings([
      review({ id: "r1", agent_id: null, created_at: "2026-08-18T12:00:00.000Z", findings: [finding({ id: "old" })] }),
      review({ id: "r2", agent_id: null, created_at: "2026-08-18T13:00:00.000Z", findings: [finding({ id: "new" })] }),
    ]);
    expect(found.map((f) => f.id)).toEqual(["new"]);
  });

  it("is order-independent and stable on a created_at tie", () => {
    const rows = [
      review({ id: "rB", findings: [finding({ id: "b" })] }),
      review({ id: "rA", findings: [finding({ id: "a" })] }),
    ];
    // One agent, identical timestamps → the id breaks the tie, the same way
    // whichever order the API happened to return them in.
    expect(currentFindings(rows).map((f) => f.id)).toEqual(["b"]);
    expect(currentFindings([...rows].reverse()).map((f) => f.id)).toEqual(["b"]);
  });
});

describe("buildAnnotations", () => {
  it("carries the server's finding lines and the page's severities", () => {
    const ann = buildAnnotations(SMART, [
      finding({ id: "f1", severity: "WARNING" }),
      finding({ id: "f2", severity: "CRITICAL" }),
    ]);
    expect(ann["src/a.ts"]!.findingLines).toEqual([4, 5]);
    expect(ann["src/a.ts"]!.severities).toEqual(["WARNING", "CRITICAL"]);
    expect(ann["src/b.ts"]!.severities).toEqual([]);
  });

  it("ignores a dismissed finding's severity", () => {
    const ann = buildAnnotations(SMART, [finding({ dismissed_at: "2026-08-18T00:00:00Z" })]);
    expect(ann["src/a.ts"]!.severities).toEqual([]);
    expect(ann["src/a.ts"]!.lineSeverities).toEqual({});
  });

  it("gives each highlighted line the worst severity of the findings covering it", () => {
    const ann = buildAnnotations(SMART, [
      finding({ id: "f1", severity: "SUGGESTION", start_line: 4, end_line: 5 }),
      finding({ id: "f2", severity: "CRITICAL", start_line: 5, end_line: 5 }),
    ]);
    // Line 4 is only the suggestion's; line 5 is hit by both, and the critical wins.
    expect(ann["src/a.ts"]!.lineSeverities).toEqual({ 4: "SUGGESTION", 5: "CRITICAL" });
  });

  it("groups each finding's anchor line by its severity, for the per-severity badges", () => {
    const ann = buildAnnotations(SMART, [
      finding({ id: "f1", severity: "CRITICAL", start_line: 4, end_line: 4 }),
      finding({ id: "f2", severity: "WARNING", start_line: 5, end_line: 5 }),
      finding({ id: "f3", severity: "WARNING", start_line: 5, end_line: 5 }),
    ]);
    // One anchor per finding start line, deduped — clicking the WARNING badge
    // steps through warnings only, never through the critical's line.
    expect(ann["src/a.ts"]!.severityLines).toEqual({ CRITICAL: [4], WARNING: [5] });
  });

  it("joins a `./`-prefixed finding path onto its file, the way the server does", () => {
    const ann = buildAnnotations(SMART, [finding({ file: "./src/a.ts", severity: "CRITICAL" })]);
    expect(ann["src/a.ts"]!.severities).toEqual(["CRITICAL"]);
    expect(ann["src/a.ts"]!.lineSeverities).toEqual({ 4: "CRITICAL", 5: "CRITICAL" });
  });

  it("keeps boilerplate shut and opens anything carrying a finding", () => {
    const ann = buildAnnotations(SMART, []);
    expect(ann["pnpm-lock.yaml"]!.defaultOpen).toBe(false);
    expect(ann["src/a.ts"]!.defaultOpen).toBe(true);
    // No findings and not boilerplate → the viewer's own size rule decides.
    expect(ann["src/b.ts"]!.defaultOpen).toBeUndefined();
  });
});

describe("withFoldOverrides", () => {
  it("lets a session override beat the role default, and leaves the rest alone", () => {
    const base = { "pnpm-lock.yaml": { defaultOpen: false } };
    const files = [file("pnpm-lock.yaml"), file("src/a.ts")];
    const overrides: Record<string, boolean> = { "pnpm-lock.yaml": true };
    const out = withFoldOverrides(base, files, (path) => overrides[path]);
    // The user opened the lock file this session — it must stay open on remount.
    expect(out["pnpm-lock.yaml"]!.defaultOpen).toBe(true);
    // No override, no entry manufactured: src/a.ts keeps the size rule.
    expect(out["src/a.ts"]).toBeUndefined();
  });
});

describe("withRoleTags", () => {
  it("stamps every grouped file with its group's tag", () => {
    const out = withRoleTags({}, SMART, (role) => ({
      label: role.toUpperCase(),
      color: "c",
      bg: "b",
    }));
    expect(out["src/a.ts"]!.tag!.label).toBe("CORE");
    expect(out["pnpm-lock.yaml"]!.tag!.label).toBe("BOILERPLATE");
  });
});

describe("diffLineIndex / findingInDiff", () => {
  const PATCH = ["@@ -1,2 +1,3 @@", " ctx", "+added", " ctx2"].join("\n");
  const index = diffLineIndex([{ path: "src/a.ts", additions: 1, deletions: 0, patch: PATCH }]);

  it("indexes the new-side lines the patch actually shows", () => {
    expect(index.get("src/a.ts")).toEqual(new Set([1, 2, 3]));
  });

  it("accepts a finding on a rendered line and rejects one outside the hunks", () => {
    expect(findingInDiff(finding({ start_line: 2 }), index)).toBe(true);
    // Line 40 exists in the file but not in this diff — the jump can't land.
    expect(findingInDiff(finding({ start_line: 40 }), index)).toBe(false);
    expect(findingInDiff(finding({ file: "not/in/diff.ts" }), index)).toBe(false);
  });

  it("treats a file-level finding (no line) as visible when its file is", () => {
    expect(findingInDiff(finding({ start_line: undefined }), index)).toBe(true);
  });
});
