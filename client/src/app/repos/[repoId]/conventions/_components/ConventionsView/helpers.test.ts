import { describe, it, expect } from "vitest";
import type { ConventionCandidate, ConventionScan } from "@devdigest/shared";
import {
  acceptedIds,
  bodyLines,
  confidenceColor,
  confidencePct,
  estimateTokens,
  isHeadingLine,
  isScanning,
  relativeTime,
} from "./helpers";
import { CONFIDENCE_OK, CONFIDENCE_WARN } from "./constants";

/**
 * The confidence-colour thresholds are the load-bearing part: they are a COPY of
 * the kit's `ConfidenceNum`, so a change on either side that is not mirrored
 * would have the meter and the numeric readout disagree about the same score.
 * These tests pin the boundaries exactly.
 */

function candidate(over: Partial<ConventionCandidate>): ConventionCandidate {
  return {
    id: "cv1",
    repo_id: "r1",
    rule: "A rule.",
    evidence_path: null,
    evidence_snippet: null,
    confidence: 0.9,
    status: "pending",
    edited: false,
    created_at: "2026-08-11T08:00:00.000Z",
    updated_at: "2026-08-11T08:00:00.000Z",
    last_seen_at: null,
    ...over,
  };
}

describe("confidencePct", () => {
  it("rounds 0..1 to a whole percentage", () => {
    expect(confidencePct(0.914)).toBe(91);
    expect(confidencePct(0.785)).toBe(79);
  });

  it("returns null when the model gave no confidence", () => {
    // null, not 0 — "unknown" and "no confidence at all" are different facts,
    // and the meter hides entirely for the former.
    expect(confidencePct(null)).toBeNull();
    expect(confidencePct(undefined)).toBeNull();
  });

  it("clamps a value outside the range", () => {
    expect(confidencePct(1.4)).toBe(100);
    expect(confidencePct(-1)).toBe(0);
  });
});

describe("confidenceColor", () => {
  it("is green at the ok threshold and above", () => {
    expect(confidenceColor(CONFIDENCE_OK)).toBe("var(--ok)");
    expect(confidenceColor(91)).toBe("var(--ok)");
  });

  it("is amber from the warn threshold up to just below ok", () => {
    expect(confidenceColor(CONFIDENCE_WARN)).toBe("var(--warn)");
    expect(confidenceColor(CONFIDENCE_OK - 1)).toBe("var(--warn)");
  });

  it("is muted below the warn threshold, and for an unknown confidence", () => {
    expect(confidenceColor(CONFIDENCE_WARN - 1)).toBe("var(--text-muted)");
    expect(confidenceColor(null)).toBe("var(--text-muted)");
  });
});

describe("acceptedIds", () => {
  it("returns only the accepted ids, in list order", () => {
    expect(
      acceptedIds([
        candidate({ id: "a", status: "accepted" }),
        candidate({ id: "b", status: "pending" }),
        candidate({ id: "c", status: "rejected" }),
        candidate({ id: "d", status: "accepted" }),
      ]),
    ).toEqual(["a", "d"]);
  });

  it("is empty when nothing is accepted", () => {
    expect(acceptedIds([candidate({ status: "rejected" })])).toEqual([]);
  });
});

describe("isScanning", () => {
  const scan = (status: ConventionScan["status"]): ConventionScan => ({
    repo_id: "r1",
    status,
    reason: null,
    sample_files: 0,
    selected_files: 0,
    candidates_found: 0,
    new_candidates: 0,
    provider: null,
    model: null,
    started_at: null,
    finished_at: null,
    error: null,
  });

  it("is true while queued or running", () => {
    expect(isScanning(scan("queued"))).toBe(true);
    expect(isScanning(scan("running"))).toBe(true);
  });

  it("is false for every terminal status, and for no scan at all", () => {
    for (const st of ["idle", "done", "failed", "degraded"] as const) {
      expect(isScanning(scan(st))).toBe(false);
    }
    expect(isScanning(undefined)).toBe(false);
  });
});

describe("relativeTime", () => {
  it("formats minutes, hours and days", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(relativeTime(ago(10_000))).toBe("now");
    expect(relativeTime(ago(5 * 60_000))).toBe("5m");
    expect(relativeTime(ago(60 * 60_000))).toBe("1h");
    expect(relativeTime(ago(48 * 60 * 60_000))).toBe("2d");
  });

  it("carries no suffix — the wording belongs to the message", () => {
    expect(relativeTime(new Date(Date.now() - 60 * 60_000).toISOString())).not.toContain("ago");
  });

  it("degrades to a dash for a missing or unparseable timestamp", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime("not a date")).toBe("—");
  });
});

describe("estimateTokens", () => {
  it("grows with the text and is never negative", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBeGreaterThan(estimateTokens("a".repeat(40)));
  });
});

describe("bodyLines / isHeadingLine", () => {
  it("keeps blank lines, so the gutter numbering matches the source", () => {
    expect(bodyLines("# a\n\nb")).toEqual(["# a", "", "b"]);
  });

  it("recognises every ATX heading level", () => {
    expect(isHeadingLine("# One")).toBe(true);
    expect(isHeadingLine("###### Six")).toBe(true);
  });

  it("does not treat a hash without a space, or prose, as a heading", () => {
    expect(isHeadingLine("#NoSpace")).toBe(false);
    expect(isHeadingLine("Use #tags in prose")).toBe(false);
    expect(isHeadingLine("")).toBe(false);
  });
});
