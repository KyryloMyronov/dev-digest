import type { UnifiedDiff } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { PullRow } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';

/** The repo row, referenced through the schema rather than through another
 *  module's repository — `no-cross-module-internals` forbids importing that
 *  type, and `intent-pipeline.ts` reaches it the same way. */
type RepoRow = typeof schema.repos.$inferSelect;

/**
 * SPEC-02 — load the unified diff for a PR.
 *
 * A DELIBERATE NEAR-DUPLICATE of `modules/reviews/diff-loader.ts`, and it must
 * stay one. Two reasons, in order:
 *   1. `no-cross-module-internals` forbids importing another module's
 *      internals, and `diff-loader.ts` is not part of the reviews module's
 *      public surface (that is its `constants.ts` + `types.ts`).
 *   2. Promoting `loadDiff` to `platform/` would refactor the REVIEW CRITICAL
 *      PATH for a feature that does not need that risk.
 *
 * So: do NOT "dedupe" this into an import of `reviews/diff-loader.js` — that
 * breaks `pnpm lint:arch`. If a third consumer ever appears, promoting it then
 * is a decision with its own blast radius.
 *
 * The one difference from the reviews loader: it reads `pr_files` through
 * `container.pullsRepo` (the sanctioned cross-module seam) rather than through
 * the reviews repository.
 */
export async function loadBriefDiff(
  container: Container,
  pull: PullRow,
  repo: RepoRow,
): Promise<UnifiedDiff> {
  try {
    const diff = await container.git.diff(
      { owner: repo.owner, name: repo.name },
      pull.base,
      pull.headSha,
    );
    if (diff.files.length > 0) return diff;
  } catch {
    /* fall through to pr_files reconstruction */
  }
  return diffFromPrFiles(container, pull.id);
}

/** Reconstruct a UnifiedDiff from persisted `pr_files` patches. */
export async function diffFromPrFiles(
  container: Container,
  prId: string,
): Promise<UnifiedDiff> {
  const files = await container.pullsRepo.listFiles(prId);
  const parts: string[] = [];
  for (const f of files) {
    // A null patch (binary, too large, or never fetched) emits NO `+++` header,
    // so the parser never gives the file a path and `files.filter(f => f.path)`
    // drops it — the file is genuinely absent from the diff, which is what
    // makes AC-25's "file not present" the honest drop reason.
    if (!f.patch) continue;
    parts.push(`diff --git a/${f.path} b/${f.path}`);
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    parts.push(f.patch);
  }
  return parseUnifiedDiff(parts.join('\n'));
}
