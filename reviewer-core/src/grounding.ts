import type { Finding, UnifiedDiff } from '@devdigest/shared';

/**
 * Citation grounding — the mandatory mechanical gate for diff-findings.
 *
 * A diff-finding is kept ONLY if its [start_line, end_line] range intersects a
 * real hunk in the unified diff for the same file. Findings that fail are
 * dropped (the model "hallucinated" a location).
 *
 * EXCEPTION: findings from full-file scanners (hooks / blast / onboarding) are
 * not tied to a diff hunk — they ground against the file existing in the diff
 * (or are exempted entirely). We treat `kind` in {secret_leak, lethal_trifecta,
 * phantom, hook} as full-file: they only require the file to be present.
 */

const FULL_FILE_KINDS = new Set(['secret_leak', 'lethal_trifecta', 'phantom', 'hook']);

export interface GroundingResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/** The minimum a claim must carry to be gated: a file and a new-side range. */
export interface Citation {
  file: string;
  start_line: number;
  end_line: number;
}

export interface CitationGroundingResult<T> {
  kept: T[];
  dropped: { item: T; reason: string }[];
}

export interface GroundCitationsOptions<T> {
  /**
   * Exempt an item from LINE anchoring — it then grounds on file presence
   * alone. Used for two things and nothing else:
   *   - `groundFindings`, which maps FULL_FILE_KINDS through it;
   *   - a review-focus entry that carries no line range at all (SPEC-02 AC-27),
   *     where the caller passes `() => true` so the intent is explicit at the
   *     call site rather than encoded in magic zeros.
   *
   * NOTE: the file-presence check runs BEFORE this exemption, so an exempt item
   * naming a file absent from the diff is still dropped.
   */
  fullFile?: (item: T) => boolean;
}

/** Build a quick lookup of file → set of new-side line numbers covered by hunks. */
export function buildLineIndex(diff: UnifiedDiff): Map<string, Set<number>> {
  const idx = new Map<string, Set<number>>();
  for (const f of diff.files) {
    const set = new Set<number>();
    for (const h of f.hunks) {
      if (h.newLineNumbers && h.newLineNumbers.length > 0) {
        for (const n of h.newLineNumbers) set.add(n);
      } else {
        // fall back to the hunk's declared new range
        for (let n = h.newStart; n < h.newStart + Math.max(h.newLines, 1); n++) set.add(n);
      }
    }
    idx.set(f.path, set);
  }
  return idx;
}

function rangeIntersects(lines: Set<number>, start: number, end: number): boolean {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  for (let n = lo; n <= hi; n++) if (lines.has(n)) return true;
  return false;
}

/**
 * Apply the grounding gate to any citation-shaped claims against a unified
 * diff — a finding, a SPEC-02 risk, a review-focus entry. The gate reads only
 * `file`, `start_line` and `end_line`, so a claim does not have to be dressed
 * up as a `Finding` to be gated.
 *
 * This is THE seam. `FULL_FILE_KINDS` stays private to this module and is
 * reachable only through `groundFindings` below, so a caller that happens to
 * carry a `kind` field cannot exempt itself from line anchoring by naming one.
 *
 * Order matters and is load-bearing: the file-presence check runs BEFORE the
 * full-file exemption, so even an exempt item is dropped when its file is
 * absent from the diff. That is why "file not in diff" and "range hits no
 * hunk" are two distinct, separately-observable outcomes.
 *
 * An item with `start_line == null` is NOT special-cased here — a caller with
 * line-less citations (SPEC-02's review focus) passes `fullFile: () => true`
 * so that decision is visible at the call site.
 */
export function groundCitations<T extends Citation>(
  items: T[],
  diff: UnifiedDiff,
  opts: GroundCitationsOptions<T> = {},
): CitationGroundingResult<T> {
  const lineIndex = buildLineIndex(diff);
  const filesInDiff = new Set(diff.files.map((f) => f.path));
  const kept: T[] = [];
  const dropped: { item: T; reason: string }[] = [];

  for (const item of items) {
    const isFullFile = opts.fullFile ? opts.fullFile(item) : false;

    if (!filesInDiff.has(item.file)) {
      dropped.push({ item, reason: `file '${item.file}' not present in diff` });
      continue;
    }

    if (isFullFile) {
      // full-file scanners only need the file to be in the diff
      kept.push(item);
      continue;
    }

    const lines = lineIndex.get(item.file) ?? new Set<number>();
    if (rangeIntersects(lines, item.start_line, item.end_line)) {
      kept.push(item);
    } else {
      dropped.push({
        item,
        reason: `lines ${item.start_line}-${item.end_line} do not intersect any diff hunk in '${item.file}'`,
      });
    }
  }

  return { kept, dropped };
}

/**
 * Apply the grounding gate to a set of findings against a unified diff.
 * Returns the kept findings and the dropped ones with reasons (for the trace).
 *
 * A thin wrapper over `groundCitations`: the ONLY thing it adds is the
 * FULL_FILE_KINDS mapping, which is what keeps that set private to this module.
 * Behaviour — including both drop-reason strings, which are persisted into
 * `run_traces` — is byte-identical to the pre-SPEC-02 implementation.
 */
export function groundFindings(findings: Finding[], diff: UnifiedDiff): GroundingResult {
  const result = groundCitations(findings, diff, {
    fullFile: (f) => (f.kind ? FULL_FILE_KINDS.has(f.kind) : false),
  });
  return {
    kept: result.kept,
    dropped: result.dropped.map((d) => ({ finding: d.item, reason: d.reason })),
  };
}

/** Human-readable summary, e.g. "3/3 passed" used in run-trace stats. */
export function groundingSummary(result: GroundingResult): string {
  const total = result.kept.length + result.dropped.length;
  return `${result.kept.length}/${total} passed`;
}
