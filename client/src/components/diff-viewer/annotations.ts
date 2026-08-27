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
