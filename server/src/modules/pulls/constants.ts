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
