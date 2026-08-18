import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * Demo conventions for the seeded `acme/payments-api` repo.
 *
 * Seeded rather than extracted because the demo repo has no clone on disk and is
 * never indexed, so a real scan can only ever degrade to `not_indexed`. Without
 * these rows the Conventions screen is permanently empty on a fresh
 * `./scripts/dev.sh`, which makes the feature undemonstrable and leaves the
 * browser flow nothing deterministic to assert on.
 *
 * All three land as `pending` on purpose: the point of the screen is the review,
 * and pre-accepting them would skip the step the user is here to perform.
 *
 * Confidences are deliberately spread across the colour thresholds (≥85 green,
 * ≥65 amber) so the meter demonstrates more than one state, and they double as
 * the list's sort order.
 */

interface SeedConvention {
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
}

export const SEED_CONVENTIONS: SeedConvention[] = [
  {
    rule: 'Always use async/await instead of .then() chains.',
    evidencePath: 'src/api/users.ts',
    evidenceSnippet:
      'const user = await db.users.find(id);\nconst posts = await db.posts.findMany({ userId });',
    confidence: 0.91,
  },
  {
    rule: 'Redis access goes through the src/lib/redis.ts singleton.',
    evidencePath: 'src/lib/redis.ts',
    evidenceSnippet: 'export const redis = new Redis(config.redisUrl);',
    confidence: 0.85,
  },
  {
    rule: 'All public route handlers return a typed Result<T, ApiError>.',
    evidencePath: 'src/api/public/index.ts',
    evidenceSnippet: 'function handler(): Result<Item[], ApiError> {\n  return ok(items);\n}',
    confidence: 0.78,
  },
];

/** Sample size the demo scan reports — the screen's "detected from N files". */
const DEMO_SAMPLE_FILES = 84;
const DEMO_SELECTED_FILES = 12;

/** How long ago the demo scan finished, so the subtitle reads "last scan 1h". */
const DEMO_SCAN_AGE_MS = 60 * 60 * 1000;

/**
 * Idempotent: conventions are matched by `source_rule` (the same key a re-scan
 * uses), and the scan row is upserted on its `repo_id` primary key.
 */
export async function seedConventions(
  db: Db,
  workspaceId: string,
  repoId: string,
): Promise<void> {
  const now = new Date();
  const finishedAt = new Date(now.getTime() - DEMO_SCAN_AGE_MS);

  for (const c of SEED_CONVENTIONS) {
    const [existing] = await db
      .select({ id: t.conventions.id })
      .from(t.conventions)
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          eq(t.conventions.sourceRule, c.rule),
        ),
      );
    if (existing) continue;

    await db.insert(t.conventions).values({
      workspaceId,
      repoId,
      // The model's original wording and the displayed rule start identical; a
      // user edit moves `rule` and leaves `sourceRule` as the match key.
      sourceRule: c.rule,
      rule: c.rule,
      evidencePath: c.evidencePath,
      evidenceSnippet: c.evidenceSnippet,
      confidence: c.confidence,
      status: 'pending',
      lastSeenAt: finishedAt,
    });
  }

  const scan = {
    status: 'done' as const,
    reason: null,
    sampleFiles: DEMO_SAMPLE_FILES,
    selectedFiles: DEMO_SELECTED_FILES,
    candidatesFound: SEED_CONVENTIONS.length,
    newCandidates: SEED_CONVENTIONS.length,
    provider: 'openai',
    model: 'gpt-5.4',
    startedAt: finishedAt,
    finishedAt,
    error: null,
    updatedAt: now,
  };

  await db
    .insert(t.conventionScanState)
    .values({ repoId, workspaceId, ...scan })
    .onConflictDoUpdate({ target: t.conventionScanState.repoId, set: scan });
}
