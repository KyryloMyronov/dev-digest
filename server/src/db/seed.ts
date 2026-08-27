import 'dotenv/config';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { eq, and } from 'drizzle-orm';
import {
  GENERAL_REVIEWER_PROMPT,
  SECURITY_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  TEST_QUALITY_REVIEWER_PROMPT,
} from './seed-prompts.js';
import { seedConventions } from './seed-conventions.js';
import { seedProjectContext } from './seed-context.js';
import { seedSkills } from './seed-skills.js';
import { seedClaudeSkills } from './seed-claude-skills.js';

/** Default provider/model for the built-in reviewer agents. */
const DEFAULT_PROVIDER = 'openrouter' as const;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Seed the starter's demo data. Idempotent: re-running upserts the default
 * workspace/user and the demo fixtures.
 *
 * Seeds: default workspace + system user + membership, default settings,
 * demo repo (acme/payments-api), its seven demo PRs (#482 #479 #477 #471 #468
 * #460 #455) each with files/commits and a review, findings on #482 and #455,
 * and the three built-in agents (General + Security + Performance), all on the
 * default openrouter/deepseek-v4-flash provider+model.
 *
 * The PR set is deliberately varied — S/M/L sizes, scores 44-95, all three
 * review states, and findings counters ranging from all-zero to a no-critical
 * spread — because the Pull Requests list is the screen the starter opens on and
 * a single row demonstrates none of it.
 *
 * Also seeds three demo conventions on that repo plus the scan that "found"
 * them (see seed-conventions.ts): the demo repo has no clone and is never
 * indexed, so a real extraction can only degrade, and the Conventions screen
 * would otherwise be permanently empty.
 *
 * Course lessons populate the remaining tables (skills, memory, eval, …) once
 * their features are built — those start empty here.
 */

export const DEFAULT_WORKSPACE_NAME = 'default';
export const SYSTEM_USER_EMAIL = 'you@local';

export async function seed(db: Db): Promise<{ workspaceId: string; userId: string }> {
  // ---- workspace + user (no-auth defaults) ----
  let [ws] = await db
    .select()
    .from(t.workspaces)
    .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
  if (!ws) {
    [ws] = await db
      .insert(t.workspaces)
      .values({ name: DEFAULT_WORKSPACE_NAME })
      .returning();
  }
  const workspaceId = ws!.id;

  let [user] = await db.select().from(t.users).where(eq(t.users.email, SYSTEM_USER_EMAIL));
  if (!user) {
    [user] = await db
      .insert(t.users)
      .values({ email: SYSTEM_USER_EMAIL, name: 'You' })
      .returning();
  }
  const userId = user!.id;

  await db
    .insert(t.workspaceMembers)
    .values({ workspaceId, userId, role: 'owner' })
    .onConflictDoNothing();

  // ---- default settings ----
  const defaultSettings: Record<string, unknown> = {
    polling_interval_min: 5,
    theme: 'dark',
    density: 'regular',
    sync_to_folder: true,
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(t.settings)
      .values({ workspaceId, userId, key, value })
      .onConflictDoNothing();
  }

  // ---- demo repo (acme/payments-api) ----
  let [repo] = await db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.fullName, 'acme/payments-api')));
  if (!repo) {
    [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'payments-api',
        fullName: 'acme/payments-api',
        defaultBranch: 'main',
        clonePath: null,
        createdBy: userId,
      })
      .returning();
  }
  const repoId = repo!.id;

  /** Relative to seed time, so a fresh DB always reads "3h ago", not a fixed date. */
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  // ---- PR #482 (rate limiting) ----
  let [pr] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 482)));
  if (!pr) {
    [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 482,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'a1b2c3d4e5f6',
        additions: 247,
        deletions: 38,
        filesCount: 9,
        status: 'needs_review',
        body: 'Add rate limiting to public API endpoints to prevent abuse from unauthenticated clients.',
        openedAt: hoursAgo(27),
        updatedAt: hoursAgo(3),
      })
      .returning();

    // pr_files (subset)
    await db.insert(t.prFiles).values([
      { prId: pr!.id, path: 'src/middleware/ratelimit.ts', additions: 84, deletions: 0 },
      { prId: pr!.id, path: 'src/api/public/webhooks.ts', additions: 31, deletions: 6 },
      { prId: pr!.id, path: 'src/config.ts', additions: 4, deletions: 0 },
      { prId: pr!.id, path: 'src/api/users.ts', additions: 7, deletions: 2 },
    ]);

    // pr_commits
    await db.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'a1b2c3d4e5f6',
      message: 'Add token-bucket rate limiter',
      author: 'marisa.koch',
    });

    // a sample review + findings so the PR shows results before the first run
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Solid middleware approach, but a Stripe secret key is committed in plaintext and the user-list endpoint introduces an N+1 query under the new limiter.',
        score: 61,
        model: 'seed',
      })
      .returning();

    await db.insert(t.findings).values([
      {
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 12,
        endLine: 12,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key in commit',
        rationale: 'Line 12 contains a literal `sk_live_` Stripe secret key.',
        suggestion: 'Move to env var and rotate the key immediately.',
        confidence: 0.98,
      },
      {
        reviewId: review!.id,
        file: 'src/api/users.ts',
        startLine: 45,
        endLine: 52,
        severity: 'WARNING',
        category: 'perf',
        title: 'N+1 query in user list endpoint',
        rationale: 'Loop issues one query per user → N+1.',
        suggestion: 'Use a single IN query and group in memory.',
        confidence: 0.86,
      },
    ]);
  }

  // ---- the rest of the demo PR list (#479 … #455) ----
  // The starter ships a PR *list*, not a single PR: the Pull Requests screen only
  // reads as designed with a spread of sizes, scores, review states and findings
  // counters. Same idempotency rule as #482 — keyed on (repo, number), so a
  // re-seed adds nothing and never rewrites a row someone has since acted on.
  //
  // One consequence of seeding times relative to now: `deriveReviewStatus` turns
  // a reviewed-at-head PR `stale` past STALE_DAYS (7), so #460 (9d) and #455
  // (14d) read stale by construction — and a long-lived DB drifts the same way.
  type SeedFinding = Omit<typeof t.findings.$inferInsert, 'reviewId'>;
  interface DemoPr {
    number: number;
    title: string;
    author: string;
    branch: string;
    headSha: string;
    additions: number;
    deletions: number;
    /** Drives the UPDATED column, and past STALE_DAYS the `stale` status. */
    updatedHoursAgo: number;
    files: { path: string; additions: number; deletions: number }[];
    commitMessage: string;
    /**
     * Whether the CURRENT head is the commit the review ran against. False ⇒ the
     * author pushed after the review, so the row keeps its score but reads
     * `needs_review` — the most common real state, and the one the list exists to
     * surface. Ignored when `review` is null (never reviewed at all).
     */
    headReviewed: boolean;
    /** null ⇒ never reviewed: no score, and all-zero findings counters. */
    review: {
      score: number;
      verdict: string;
      summary: string;
      findings: SeedFinding[];
    } | null;
  }

  const demoPrs: DemoPr[] = [
    {
      number: 479,
      title: 'Migrate sessions table to UUID primary key',
      author: 'deepak.r',
      branch: 'chore/sessions-uuid-pk',
      headSha: 'b2c3d4e5f6a1',
      additions: 1102,
      deletions: 138,
      updatedHoursAgo: 6,
      files: [
        { path: 'src/db/migrations/0014_sessions_uuid.sql', additions: 62, deletions: 0 },
        { path: 'src/db/schema/sessions.ts', additions: 41, deletions: 18 },
        { path: 'src/modules/auth/repository.ts', additions: 999, deletions: 120 },
      ],
      commitMessage: 'Migrate sessions.id to uuid and backfill',
      headReviewed: false,
      review: {
        score: 44,
        verdict: 'request_changes',
        summary:
          'The migration rewrites the sessions table in place with no batching and no rollback path; every logged-in user is invalidated the moment it runs.',
        findings: [],
      },
    },
    {
      number: 477,
      title: 'Fix flaky checkout integration test',
      author: 'tomek.w',
      branch: 'fix/flaky-checkout-test',
      headSha: 'c3d4e5f6a1b2',
      additions: 34,
      deletions: 8,
      updatedHoursAgo: 24,
      files: [{ path: 'test/checkout.it.test.ts', additions: 34, deletions: 8 }],
      commitMessage: 'Await the settlement webhook instead of sleeping',
      headReviewed: true,
      review: {
        score: 92,
        verdict: 'approve',
        summary:
          'Replaces a fixed sleep with an explicit wait on the settlement webhook. Deterministic and a clear improvement.',
        findings: [],
      },
    },
    {
      number: 471,
      title: 'Refactor invoice PDF renderer',
      author: 'sara.lin',
      branch: 'refactor/invoice-pdf',
      headSha: 'd4e5f6a1b2c3',
      additions: 640,
      deletions: 240,
      updatedHoursAgo: 47,
      files: [
        { path: 'src/invoices/render.ts', additions: 412, deletions: 205 },
        { path: 'src/invoices/templates/default.tsx', additions: 228, deletions: 35 },
      ],
      commitMessage: 'Split the renderer into layout + paint passes',
      headReviewed: true,
      // 47h vs #468's 49h: both read "2d", but the hour keeps newest-first sort
      // stable instead of leaving two equal timestamps to tie-break arbitrarily.
      review: {
        score: 73,
        verdict: 'comment',
        summary:
          'The layout/paint split is a real improvement; the new template path is not covered by a test yet.',
        findings: [],
      },
    },
    {
      number: 468,
      title: 'Add idempotency keys to charge endpoint',
      author: 'marisa.koch',
      branch: 'feat/charge-idempotency',
      headSha: 'e5f6a1b2c3d4',
      additions: 268,
      deletions: 42,
      updatedHoursAgo: 49,
      files: [
        { path: 'src/api/charges.ts', additions: 176, deletions: 30 },
        { path: 'src/db/schema/idempotency.ts', additions: 92, deletions: 12 },
      ],
      commitMessage: 'Store and replay idempotency keys per charge',
      headReviewed: true,
      review: {
        score: 81,
        verdict: 'approve',
        summary:
          'Keys are stored before the provider call and replayed correctly on retry. Sensible TTL.',
        findings: [],
      },
    },
    {
      number: 460,
      title: 'Bump node 18 → 20 in CI',
      author: 'deepak.r',
      branch: 'chore/node-20',
      headSha: 'f6a1b2c3d4e5',
      additions: 14,
      deletions: 4,
      updatedHoursAgo: 216, // 9d — past STALE_DAYS, so this row reads "stale"
      files: [{ path: '.github/workflows/ci.yml', additions: 14, deletions: 4 }],
      commitMessage: 'Bump CI node to 20',
      headReviewed: true,
      review: {
        score: 95,
        verdict: 'approve',
        summary: 'Straight version bump; the lockfile and engines field agree.',
        findings: [],
      },
    },
    {
      number: 455,
      title: 'Webhook retry with exponential backoff',
      author: 'tomek.w',
      branch: 'feat/webhook-backoff',
      headSha: 'a1b2c3d4e5f7',
      additions: 198,
      deletions: 42,
      updatedHoursAgo: 336, // 14d — stale
      files: [
        { path: 'src/webhooks/retry.ts', additions: 121, deletions: 18 },
        { path: 'src/webhooks/queue.ts', additions: 54, deletions: 20 },
        { path: 'src/config.ts', additions: 23, deletions: 4 },
      ],
      commitMessage: 'Retry failed webhook deliveries with jittered backoff',
      headReviewed: true,
      // The one row with a spread of severities but NO critical — the demo's
      // example of a zero counter sitting next to two live ones.
      review: {
        score: 68,
        verdict: 'comment',
        summary:
          'Backoff itself is correct. The retry ceiling is unbounded and the jitter is derived from a non-random source, so a provider outage would synchronise every retry.',
        findings: [
          {
            file: 'src/webhooks/retry.ts',
            startLine: 34,
            endLine: 41,
            severity: 'WARNING',
            category: 'bug',
            title: 'Retry loop has no maximum attempt ceiling',
            rationale:
              'The loop re-enqueues on any failure with no attempt counter, so a permanently rejecting endpoint is retried forever.',
            suggestion: 'Cap attempts (5 is typical) and move exhausted deliveries to a dead-letter table.',
            confidence: 0.91,
          },
          {
            file: 'src/webhooks/retry.ts',
            startLine: 58,
            endLine: 63,
            severity: 'WARNING',
            category: 'perf',
            title: 'Jitter derived from the delivery id, not a random source',
            rationale:
              'Using the id modulo a constant makes the jitter deterministic per delivery, so all retries of one batch land in the same slot.',
            suggestion: 'Use a random offset in [0, base) so retries spread across the window.',
            confidence: 0.78,
          },
          {
            file: 'src/webhooks/queue.ts',
            startLine: 12,
            endLine: 12,
            severity: 'SUGGESTION',
            category: 'style',
            title: 'Backoff constants belong in config, not the queue module',
            rationale: 'The base delay and multiplier are literals here but configurable everywhere else.',
            suggestion: 'Move them next to the other webhook settings in src/config.ts.',
            confidence: 0.62,
          },
          {
            file: 'src/webhooks/retry.ts',
            startLine: 71,
            endLine: 74,
            severity: 'SUGGESTION',
            category: 'test',
            title: 'No test covers the backoff schedule itself',
            rationale: 'The suite asserts that a retry happens, never the delay sequence it happens on.',
            suggestion: 'Add a test with a fake clock asserting the first four delays.',
            confidence: 0.7,
          },
          {
            file: 'src/webhooks/queue.ts',
            startLine: 44,
            endLine: 49,
            severity: 'SUGGESTION',
            category: 'style',
            title: 'Duplicated enqueue logic between retry and first delivery',
            rationale: 'Both paths build the same payload envelope with slightly different field order.',
            suggestion: 'Extract a single buildEnvelope() used by both.',
            confidence: 0.58,
          },
          {
            file: 'src/config.ts',
            startLine: 31,
            endLine: 34,
            severity: 'SUGGESTION',
            category: 'bug',
            title: 'Webhook timeout is not validated against the backoff base',
            rationale:
              'A timeout longer than the base delay lets a slow delivery and its own retry run concurrently.',
            suggestion: 'Assert timeout < baseDelay at config load.',
            confidence: 0.55,
          },
        ],
      },
    },
  ];

  for (const d of demoPrs) {
    const [existing] = await db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, d.number)));
    if (existing) continue;

    const updatedAt = hoursAgo(d.updatedHoursAgo);
    const [row] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: d.number,
        title: d.title,
        author: d.author,
        branch: d.branch,
        base: 'main',
        headSha: d.headSha,
        // `status` holds GitHub's merge state; the review status on the list is
        // derived from lastReviewedSha vs headSha (+ age) by deriveReviewStatus.
        status: 'open',
        lastReviewedSha: d.review && d.headReviewed ? d.headSha : null,
        additions: d.additions,
        deletions: d.deletions,
        filesCount: d.files.length,
        body: d.review?.summary ?? null,
        openedAt: hoursAgo(d.updatedHoursAgo + 24),
        updatedAt,
      })
      .returning();

    await db.insert(t.prFiles).values(d.files.map((f) => ({ prId: row!.id, ...f })));
    await db.insert(t.prCommits).values({
      prId: row!.id,
      sha: d.headSha,
      message: d.commitMessage,
      author: d.author,
      committedAt: updatedAt,
    });

    if (!d.review) continue;
    const [rv] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: row!.id,
        kind: 'review',
        verdict: d.review.verdict,
        summary: d.review.summary,
        score: d.review.score,
        model: 'seed',
      })
      .returning();
    if (d.review.findings.length > 0) {
      await db
        .insert(t.findings)
        .values(d.review.findings.map((f) => ({ reviewId: rv!.id, ...f })));
    }
  }

  // ---- built-in agents (the three starter presets) ----
  // Prompt bodies live in ./seed-prompts.ts (mirrored in docs/agent-prompts/*.md).
  const seedAgents: Array<typeof t.agents.$inferInsert> = [
    {
      workspaceId,
      name: 'General Reviewer',
      description: 'Reviews a PR diff for bugs, correctness, and clarity.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: GENERAL_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Security Reviewer',
      description: 'Flags secrets, injection, SSRF and the lethal trifecta before merge.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: SECURITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Performance Reviewer',
      description: 'Catches N+1 queries, missing indexes, and hot-path allocations.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Test Quality Reviewer',
      description: 'Reviews the tests in a PR — does the suite actually pin the new behaviour?',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      // Deliberately thin: its rubrics are the skills linked below. See
      // seed-prompts.ts and docs/agent-prompts/test-quality-reviewer.md.
      systemPrompt: TEST_QUALITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
  ];
  for (const a of seedAgents) {
    const [existing] = await db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, a.name)));
    if (!existing) await db.insert(t.agents).values(a);
  }

  // ---- built-in skills + their agent links ----
  // AFTER the agents above: links are resolved by agent name, and a link whose
  // agent does not exist yet is skipped, not retried.
  await seedSkills(db, workspaceId);

  // ---- this repo's own `.claude/skills/*/SKILL.md`, as library rows ----
  // Unlinked from every agent on purpose: they are coding-agent guidance, not
  // review guidance, and 18 of them would swamp any review prompt.
  await seedClaudeSkills(db, workspaceId);

  // ---- demo conventions + the scan that "found" them ----
  await seedConventions(db, workspaceId, repoId);

  // ---- SPEC-01: one agent run + its trace, with a project-context block ----
  // AFTER the agents and the sample review: the run is hung off PR #482 and the
  // seeded review is linked to it, so the PR page's trace button renders and the
  // drawer opens with real findings and an agent name.
  await seedProjectContext(db, workspaceId, repoId);

  return { workspaceId, userId };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const handle = createDb(url);
  seed(handle.db)
    .then(async (r) => {
      console.log('✓ seeded', r);
      await handle.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('✗ seed failed:', err);
      await handle.close();
      process.exit(1);
    });
}
