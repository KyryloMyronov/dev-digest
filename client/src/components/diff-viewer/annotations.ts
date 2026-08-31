/* Review annotations for the DiffViewer (L03 · Smart Diff).
   Everything the viewer needs to show a PR's review findings ON the diff —
   which lines a finding points at, what severity the file's findings carry, and
   whether a file should start open. Pure data + helpers; the viewer stays
   unaware of where any of it came from. */
import type { Severity } from "../../lib/types";

/** What the viewer overlays onto ONE file of the diff. */
export interface DiffAnnotation {
  /**
   * New-side line numbers a review finding anchors to. Highlighted in the
   * gutter and the row, so the eye lands on them before the surrounding hunk.
   */
  findingLines?: readonly number[];
  /** Severities of this file's findings — the header badge. */
  severities?: readonly Severity[];
  /** Overrides the size-based auto-expand (Smart Diff collapses boilerplate). */
  defaultOpen?: boolean;
  /** Small group tag on the file header (Smart Diff role label), so a collapsed
   *  file still says which group it belongs to. */
  tag?: { label: string; color: string; bg: string };
  /** SPEC-03 — the file's derived one-line summary, already resolved for
   *  rendering. Labels arrive as STRINGS, not message keys: a shared component
   *  that resolves its own i18n namespace crashes any screen whose catalogue
   *  lacks it (client insights.md 2026-08-27), and this file already carries a
   *  resolved `tag: {label,color,bg}` for exactly that reason. */
  summary?: {
    text: string;
    headSha: string;
    /** AC-58 — `head_sha` !== the PR's current head. The TEXT still renders. */
    stale: boolean;
    /** Resolved label for the staleness badge. */
    staleLabel: string;
  };
  /** SPEC-03 AC-65 — worst severity per NEW-side line number. A line marked by
   *  `findingLines` with no entry here renders the shipped severity-neutral
   *  highlight (AC-67), which is why this map may legitimately be narrower than
   *  `findingLines` — but never the other way round. */
  severitiesByLine?: ReadonlyMap<number, Severity>;
}

/**
 * A jump-to-line request (finding → code): the viewer expands the target file,
 * scrolls the line into the vertical centre and flashes it. `token` changes on
 * every request so the same line can be jumped to twice in a row.
 */
export interface DiffReveal {
  path: string;
  /** New-side line number; null = reveal the file, nothing line-specific. */
  line: number | null;
  token: number;
}

/** Annotations by file path. Absent path = a plain, unannotated file. */
export type DiffAnnotations = Readonly<Record<string, DiffAnnotation>>;

/** Worst first — the badge shows one severity, and it has to be the loudest. */
const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };

export function worstSeverity(severities: readonly Severity[] | undefined): Severity | null {
  if (!severities || severities.length === 0) return null;
  return [...severities].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0]!;
}
