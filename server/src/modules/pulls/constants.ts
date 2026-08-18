/**
 * F1 — pulls module constants (extracted from routes.ts; no behaviour change).
 */

/**
 * Max PRs whose diff stats are backfilled in a single list request.
 *
 * GitHub's PR-*list* payload carries no additions/deletions/files_count, so a
 * freshly-imported PR lands with zeroes and the list would show it as size 0.
 * Each backfill costs one detail fetch, so the work is capped per request and
 * the periodic refetch chips away at any remainder.
 */
export const DIFF_STAT_BACKFILL_LIMIT = 10;

// ---- L03 · Smart Diff ------------------------------------------------------
// Thresholds for the deterministic (no-LLM) grouping in `smart-diff.ts`.

/**
 * Reviewable (non-boilerplate) changed lines above which a PR is flagged as too
 * big to review in one sitting. 400 is a middle reading of the usual advice
 * (200–500); the point is to nudge, so it errs on the permissive side.
 */
export const SMART_DIFF_TOO_BIG_LINES = 400;

/**
 * Core files above which a PR is flagged too big regardless of line count — ten
 * small edits spread across ten logic files is a harder review than one big one.
 */
export const SMART_DIFF_TOO_BIG_CORE_FILES = 10;

/**
 * Max lines highlighted per finding. A finding whose range is longer than this
 * is a remark about the file, and highlighting all of it highlights nothing.
 */
export const SMART_DIFF_MAX_LINES_PER_FINDING = 50;

/** Max proposed splits; the tail is merged into one "everything else" entry. */
export const SMART_DIFF_MAX_SPLITS = 5;

/** Deepest path prefix the split suggestion will cut on (`a/b/c/d`). */
export const SMART_DIFF_SPLIT_MAX_DEPTH = 4;
