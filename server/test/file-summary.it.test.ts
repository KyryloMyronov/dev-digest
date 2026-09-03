import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AuthProvider } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import { JobRunner } from '../src/platform/jobs.js';
import * as t from '../src/db/schema.js';
import {
  FILE_SUMMARY_DERIVE_JOB_KIND,
  FILE_SUMMARY_PROMPT_TOKEN_CAP,
  MAX_FILE_SUMMARY_CHARS,
} from '../src/modules/file-summary/constants.js';
import { FileSummaryRepository } from '../src/modules/file-summary/repository.js';
import { fileSummaryLlm, UsageOverridingLlm } from './helpers/file-summary.js';
import { intentLlm } from './helpers/intent.js';

/**
 * SPEC-03 — file summaries against a real Postgres.
 *
 * The unit suites cover the pipeline's decisions; what only a database can prove
 * is the round trip: that every `pr_file_summaries` column survives a write and a
 * read, that the workspace scoping is in the QUERY and not merely in the service,
 * that D-1's apportioned shares still SUM to the call's cost after a float column
 * has been through Postgres, that D-2's one-row-per-path projection actually
 * bounds the payload across force-pushes (NFR-5), and that a job that outlives
 * the runner's timeout is marked failed and writes nothing (AC-36 / NFR-10).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** ~1 600 tokens of realistic patch text per file, for the NFR-3/NFR-5 case. */
function bigPatch(seedIdx: number, lines = 120): string {
  const body = Array.from(
    { length: lines },
    (_, l) => `+  const handler${l} = await resolve("route-${seedIdx}-${l}", { retries: ${l} });`,
  );
  return [`@@ -1,1 +1,${lines} @@`, ...body].join('\n');
}

let repoSeq = 0;
async function setupRepoAndPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  files: { path: string; additions: number; deletions: number; patch: string | null }[] = [
    { path: 'src/config.ts', additions: 40, deletions: 1, patch: bigPatch(0, 8) },
    { path: 'src/api/users.ts', additions: 20, deletions: 0, patch: bigPatch(1, 6) },
    { path: 'pnpm-lock.yaml', additions: 900, deletions: 10, patch: bigPatch(2, 4) },
  ],
) {
  const name = `payments-api-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 482,
      title: 'Add rate limiting to public API endpoints',
      author: 'octocat',
      branch: 'feat/rate-limit',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      filesCount: files.length,
      status: 'needs_review',
      body: 'Adds a per-route limiter to the public endpoints.',
    })
    .returning();
  await db.insert(t.prFiles).values(files.map((f) => ({ prId: pr!.id, ...f })));
  return { repo: repo!, pr: pr! };
}

/** `POST` is a 202 receipt — poll `pr_file_summaries` like a client would. */
async function waitForRows(
  db: PgFixture['handle']['db'],
  prId: string,
  pred: (rows: (typeof t.prFileSummaries.$inferSelect)[]) => boolean,
  timeoutMs = 10_000,
) {
  const start = Date.now();
  for (;;) {
    const rows = await db
      .select()
      .from(t.prFileSummaries)
      .where(eq(t.prFileSummaries.prId, prId));
    if (pred(rows)) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

d('SPEC-03 file summaries (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  /**
   * Every provider the code will resolve is overridden, not just this feature's.
   * `file_summary` AND `review_intent` both default to **openrouter**, and an
   * agent review would resolve **openai** — a test that overrode only one would
   * let the other reach a real, billable provider on a machine that happens to
   * have a key configured (server `insights.md` 2026-08-17).
   */
  function appWith(summaryLlm = fileSummaryLlm(), auth?: AuthProvider) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: '' }),
        llm: { openrouter: summaryLlm, openai: intentLlm() },
        ...(auth ? { auth } : {}),
      },
    });
  }

  /** The fixture the model "returns" for a given set of paths. */
  const fixtureFor = (paths: string[], summary = 'Adds a token-bucket limiter keyed on bucketKey.') => ({
    summaries: paths.map((p) => ({ path: p, summary: `${summary} (${p})` })),
  });

  // ------------------------------------------------------------ AC-1 / AC-2

  it('AC-1 / AC-2 — empty before anything derived it, the records after', async () => {
    // The fixture must answer BOTH eligible paths: the default
    // `FILE_SUMMARY_FIXTURE` names only `src/config.ts`, and a path the model
    // never answers is simply never persisted (which is correct behaviour, and
    // is what `file-summary-pipeline.test.ts` asserts separately).
    const app = await appWith(
      fileSummaryLlm(fixtureFor(['src/config.ts', 'src/api/users.ts'])),
    );
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const empty = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      summaries: [],
      // `pnpm-lock.yaml` is boilerplate — never a candidate (AC-18), so it is in
      // neither the denominator nor the omitted list.
      omitted_files: ['src/config.ts', 'src/api/users.ts'],
      selected: 0,
      total: 2,
    });

    const post = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/file-summaries`,
      payload: {},
    });
    expect(post.statusCode).toBe(202);
    await app.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (rows) => rows.length === 2);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // AC-2: the payload came through the declared `PrFileSummariesResponse`.
    expect(Object.keys(body).sort()).toEqual(['omitted_files', 'selected', 'summaries', 'total']);
    expect(body.summaries).toHaveLength(2);
    expect(body.selected).toBe(2);
    expect(body.total).toBe(2);
    expect(body.omitted_files).toEqual([]);
    expect(body.summaries.every((s: { head_sha: string }) => s.head_sha === 'a1b2c3d4')).toBe(true);
    await app.close();
  });

  // -------------------------------------------------------------------- AC-8

  it('AC-8 — the POST answers 202 with the id of the enqueued job', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries` });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('accepted');
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    // The receipt names a REAL row in `jobs`.
    const [jobRow] = await pg.handle.db.select().from(t.jobs).where(eq(t.jobs.id, body.jobId));
    expect(jobRow!.kind).toBe(FILE_SUMMARY_DERIVE_JOB_KIND);
    await app.container.jobs.onIdle();
    await app.close();
  });

  // ------------------------------------------------------------------- AC-10

  it('AC-10 — a degraded 202 receipt naming the reason when no handler is registered', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    // The genuine AC-10 path: `JobRunner.enqueue` throws for an unregistered kind.
    (app.container.jobs as unknown as { handlers: Map<string, unknown> }).handlers.delete(
      FILE_SUMMARY_DERIVE_JOB_KIND,
    );

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', degraded: true, reason: 'no_handler' });
    // Degraded means nothing ran: no row, and nothing derived.
    const rows = await pg.handle.db
      .select()
      .from(t.prFileSummaries)
      .where(eq(t.prFileSummaries.prId, pr.id));
    expect(rows).toEqual([]);
    await app.close();
  });

  // ------------------------------------------------------------ AC-4 / AC-5

  it('AC-4 / AC-5 — the SAME PR id under a SECOND workspace is 404, and the QUERY is what refuses it', async () => {
    const app = await appWith(
      fileSummaryLlm(fixtureFor(['src/config.ts', 'src/api/users.ts'])),
    );
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (rows) => rows.length === 2);
    await app.close();

    // A real second tenant, not a fabricated id.
    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'second-tenant' })
      .returning();
    const otherAuth: AuthProvider = {
      currentUser: async () => ({ id: 'user-2', email: 'x@local', name: 'x' }) as never,
      currentWorkspace: async () => ({ id: other!.id, name: 'second-tenant' }) as never,
    };

    // 1. Over HTTP: the foreign workspace gets a 404 envelope, never the rows.
    const foreign = await appWith(fileSummaryLlm(), otherAuth);
    const res = await foreign.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await foreign.close();

    // 2. AC-4 IS ABOUT THE QUERY, so assert it at the repository, below the
    //    service's own `findPull` check — the criterion must hold even if a
    //    caller forgets that check.
    const repo = new FileSummaryRepository(pg.handle.db);
    expect(await repo.listSummaries(other!.id, pr.id)).toEqual([]);
    expect(await repo.listSummariesAtHead(other!.id, pr.id, 'a1b2c3d4')).toEqual([]);
    expect((await repo.listSummaries(workspaceId, pr.id)).length).toBe(2);
  });

  // ------------------------------------------------------------------- AC-33

  it('AC-33 — every column survives the round trip, and the shares SUM to the call', async () => {
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const llm = new UsageOverridingLlm(
      { costUsd: 0.0042, tokensIn: 2_400, tokensOut: 50 },
      fixtureFor(paths),
    );
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const rows = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(paths).toContain(row.path);
      expect(row.summary.length).toBeGreaterThan(0);
      expect(row.summary.length).toBeLessThanOrEqual(MAX_FILE_SUMMARY_CHARS);
      expect(row.headSha).toBe('a1b2c3d4');
      expect(row.provider).toBe('openrouter');
      expect(row.model).toBe('deepseek/deepseek-v4-flash');
      expect(row.tokensIn).not.toBeNull();
      expect(row.tokensOut).not.toBeNull();
      expect(row.costUsd).not.toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    }
    // D-1's exactness, proven against the DATABASE rather than only in a unit
    // test: `double precision` round-trips the shares without a rounding leak.
    expect(rows.reduce((n, r) => n + (r.costUsd ?? 0), 0)).toBe(0.0042);
    expect(rows.reduce((n, r) => n + (r.tokensIn ?? 0), 0)).toBe(2_400);
    expect(rows.reduce((n, r) => n + (r.tokensOut ?? 0), 0)).toBe(50);
    await app.close();
  });

  it('AC-28 / AC-74 — an over-long summary is stored truncated, and the derivation succeeds', async () => {
    const long = 'y'.repeat(880) + 'TAILMARKER';
    const llm = new UsageOverridingLlm(
      {},
      { summaries: [{ path: 'src/config.ts', summary: long }] },
    );
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/file-summaries`,
      payload: { path: 'src/config.ts' },
    });
    await app.container.jobs.onIdle();
    const rows = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 1);

    expect(rows[0]!.summary).toHaveLength(MAX_FILE_SUMMARY_CHARS);
    expect(rows[0]!.summary).toBe(long.slice(0, MAX_FILE_SUMMARY_CHARS));
    await app.close();
  });

  // ------------------------------------------------------------------- AC-34

  it('AC-34 — an UNPRICED model stores cost_usd null on every row, never 0', async () => {
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const llm = new UsageOverridingLlm({ costUsd: null }, fixtureFor(paths));
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const rows = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);

    expect(rows.map((r) => r.costUsd)).toEqual([null, null]);
    // And `null` survives serialization as `null` — the studio must SEE it to
    // render its placeholder (AC-59); an absent field would read as "pending".
    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    expect(res.json().summaries.every((s: { cost_usd: unknown }) => s.cost_usd === null)).toBe(true);
    expect(res.body).toContain('"cost_usd":null');
    await app.close();
  });

  it('AC-34 — a genuinely ZERO-PRICED model stores 0 on every row, never null', async () => {
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const llm = new UsageOverridingLlm({ costUsd: 0 }, fixtureFor(paths));
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const rows = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);

    expect(rows.map((r) => r.costUsd)).toEqual([0, 0]);
    expect(rows.every((r) => r.costUsd !== null)).toBe(true);
    await app.close();
  });

  it('AC-16 — a cached file is not RE-WRITTEN, which is why AC-34\'s third case is vacuous', async () => {
    // AC-34's "or the file was served from a stored row" describes a write that
    // cannot happen: a cached file makes NO model call and NO write at all, so
    // no row is ever created carrying `null` for that reason. Recorded as a spec
    // text correction; asserted here so the claim is checked rather than assumed.
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const llm = new UsageOverridingLlm({ costUsd: 0.002 }, fixtureFor(paths));
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const first = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);
    const callsAfterFirst = llm.calls.length;

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const second = await pg.handle.db
      .select()
      .from(t.prFileSummaries)
      .where(eq(t.prFileSummaries.prId, pr.id));

    // No second model call, and the rows are byte-identical — same timestamps.
    expect(llm.calls.length).toBe(callsAfterFirst);
    expect(second.map((r) => r.costUsd)).toEqual(first.map((r) => r.costUsd));
    expect(second.map((r) => r.createdAt.toISOString()).sort()).toEqual(
      first.map((r) => r.createdAt.toISOString()).sort(),
    );
    await app.close();
  });

  // ------------------------------------------------------------ AC-36 / NFR-10

  it('AC-36 / NFR-10 — a handler that outlives the timeout marks the job failed and writes nothing', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    // `container.jobs` is built with NO options (`platform/container.ts`), so
    // `jobs.ts`'s defaults are what NFR-10 is about. Pin them here rather than
    // waiting two minutes for the real one…
    const shipped = new JobRunner(pg.handle.db);
    expect((shipped as unknown as { timeoutMs: number }).timeoutMs).toBe(120_000);
    expect((shipped as unknown as { retries: number }).retries).toBe(2);

    // …and drive the MECHANISM with a short one, so the suite stays fast.
    const runner = new JobRunner(pg.handle.db, { timeoutMs: 150, retries: 0 });
    runner.register(FILE_SUMMARY_DERIVE_JOB_KIND, () => new Promise(() => undefined));
    const job = await runner.enqueue(workspaceId, FILE_SUMMARY_DERIVE_JOB_KIND, {
      workspaceId,
      prId: pr.id,
    });
    await job.done.catch(() => undefined);

    const [jobRow] = await pg.handle.db.select().from(t.jobs).where(eq(t.jobs.id, job.id));
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.error).toMatch(/timed out|timeout/i);

    const rows = await pg.handle.db
      .select()
      .from(t.prFileSummaries)
      .where(eq(t.prFileSummaries.prId, pr.id));
    expect(rows).toEqual([]);
  });

  // ------------------------------------------------- NFR-5 + plan D-2's projection

  it('NFR-5 / AC-58 — after TWO force-pushes the table holds 3 rows per path and the payload holds 1, under 32 KB', async () => {
    // The PR is at the NFR-3 cap: 28 files of ~1 600 tokens each. THE TWO
    // FORCE-PUSHES ARE THE POINT — without D-2's one-row-per-path projection this
    // payload would grow without bound across head SHAs, which is the half of
    // NFR-5's "structurally unreachable" claim that was not true before D-2.
    //
    // MEASURED, NOT GUESSED: a 120-line block of this shape costs ~2 650 tokens
    // (48 000 / 18 admitted on the first run of this test), i.e. ~22 tokens per
    // line — these synthetic lines are longer than the repo average NFR-3 was
    // derived from (12.72 tokens/line). 68 lines ⇒ ~1 500 tokens/file, so all 28
    // fit and the payload carries the MAXIMUM number of rows, which is the
    // honest worst case for a size ceiling. The cap itself is exercised by
    // `file-summary-selection.test.ts` and `file-summary-pipeline.test.ts`.
    const FILE_COUNT = 28;
    const PATCH_LINES = 68;
    const files = Array.from({ length: FILE_COUNT }, (_, i) => ({
      path: `src/module${String(i).padStart(2, '0')}/handler.ts`,
      additions: PATCH_LINES,
      deletions: 0,
      patch: bigPatch(i, PATCH_LINES),
    }));
    // 300-char summaries, so every stored row is clamped to the MAXIMUM length
    // NFR-4 permits — the honest worst case for a size ceiling.
    const fixture = {
      summaries: files.map((f) => ({ path: f.path, summary: 'z'.repeat(300) })),
    };
    const llm = new UsageOverridingLlm({ costUsd: 0.0044 }, fixture);
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, files);

    const heads = ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6'];
    for (const head of heads) {
      await pg.handle.db
        .update(t.pullRequests)
        .set({ headSha: head })
        .where(eq(t.pullRequests.id, pr.id));
      await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
      await app.container.jobs.onIdle();
      await waitForRows(
        pg.handle.db,
        pr.id,
        (rows) => rows.filter((r) => r.headSha === head).length > 0,
      );
    }

    // The whole prompt stayed inside the cap, so every file was admitted…
    const stored = await pg.handle.db
      .select()
      .from(t.prFileSummaries)
      .where(eq(t.prFileSummaries.prId, pr.id));
    expect(stored.filter((r) => r.headSha === heads[2]).length).toBe(FILE_COUNT);
    // THE TABLE accumulates per head SHA — three derivations, three sets of rows.
    expect(stored.length).toBe(FILE_COUNT * heads.length);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // …and THE PAYLOAD holds exactly one row per path — the current head's.
    expect(body.summaries).toHaveLength(FILE_COUNT);
    expect(new Set(body.summaries.map((s: { path: string }) => s.path)).size).toBe(FILE_COUNT);
    expect(
      body.summaries.every((s: { head_sha: string }) => s.head_sha === heads[2]),
    ).toBe(true);
    expect(body.selected).toBe(FILE_COUNT);
    expect(body.total).toBe(FILE_COUNT);

    const bytes = Buffer.byteLength(res.body, 'utf8');
    expect(bytes).toBeLessThanOrEqual(32 * 1_024);
    // Sanity: this really is a PR sized against the NFR-3 cap, not a toy — the
    // admitted patches account for the great majority of the 48 000 budget.
    expect(FILE_COUNT * PATCH_LINES * 22).toBeGreaterThan(FILE_SUMMARY_PROMPT_TOKEN_CAP * 0.7);
    expect(FILE_COUNT * PATCH_LINES * 22).toBeLessThanOrEqual(FILE_SUMMARY_PROMPT_TOKEN_CAP);
    await app.close();
  });

  it("D-2 — the CURRENT head's row wins even when a NEWER row exists for another head", async () => {
    // THE `(fs.head_sha = p.head_sha) DESC` ORDERING TERM IS WHAT THIS PINS, and
    // nothing else does: in the ordinary force-push sequence the current head's
    // row is also the newest, so `created_at DESC` alone would give the same
    // answer and the term would be untested. Mutation-checked — deleting the
    // term from `listSummaries` fails THIS test and no other.
    //
    // The scenario is real: force-push forward to B, then force-push BACK to A
    // (a revert or a reset). A's summary already exists and is OLDER than B's,
    // but A is the commit the reviewer is looking at, so A's row must win.
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const app = await appWith(new UsageOverridingLlm({ costUsd: 0.001 }, fixtureFor(paths, 'AT-HEAD-A')));
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    // Derive at A…
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);
    await app.close();

    // …force-push to B and derive there, so B's rows are strictly NEWER…
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'bbbbbbbb' })
      .where(eq(t.pullRequests.id, pr.id));
    const app2 = await appWith(
      new UsageOverridingLlm({ costUsd: 0.001 }, fixtureFor(paths, 'AT-HEAD-B')),
    );
    await app2.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app2.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (r) => r.length === 4);

    // …then force-push BACK to A.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'a1b2c3d4' })
      .where(eq(t.pullRequests.id, pr.id));

    const res = await app2.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    const body = res.json();
    expect(body.summaries).toHaveLength(2);
    // The OLDER row wins, because it is the one that describes the current head.
    expect(body.summaries.every((x: { head_sha: string }) => x.head_sha === 'a1b2c3d4')).toBe(true);
    expect(body.summaries.every((x: { summary: string }) => x.summary.includes('AT-HEAD-A'))).toBe(
      true,
    );
    // …so nothing is stale, and the counts agree with the projection.
    expect(body.selected).toBe(2);
    expect(body.omitted_files).toEqual([]);
    await app2.close();
  });

  it('AC-58 — a stale row is served (with its own head SHA) when the current head has none', async () => {
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const llm = new UsageOverridingLlm({ costUsd: 0.001 }, fixtureFor(paths));
    const app = await appWith(llm);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);

    // Force-push, derive nothing: the stored rows now describe an older commit.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'deadbeef' })
      .where(eq(t.pullRequests.id, pr.id));

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/file-summaries` });
    const body = res.json();
    // The TEXT is still served — the studio badges it rather than hiding it.
    expect(body.summaries).toHaveLength(2);
    expect(body.summaries.every((s: { head_sha: string }) => s.head_sha === 'a1b2c3d4')).toBe(true);
    // …and the counts say plainly that nothing is fresh for the current head.
    expect(body.selected).toBe(0);
    expect(body.total).toBe(2);
    expect(body.omitted_files.sort()).toEqual(['src/api/users.ts', 'src/config.ts']);
    await app.close();
  });

  // --------------------------------------------------------- the upsert itself

  it('re-deriving at the SAME head upserts in place and moves created_at forward', async () => {
    // The multi-row `onConflictDoUpdate` writes `excluded.*` and stamps
    // `created_at` from SQL `now()`. Two clocks on one column can go BACKWARDS
    // under a VM-hosted Postgres (server `insights.md` 2026-08-17), and D-2's
    // `created_at DESC` tie-break depends on this being right.
    const paths = ['src/config.ts', 'src/api/users.ts'];
    const app = await appWith(new UsageOverridingLlm({ costUsd: 0.003 }, fixtureFor(paths, 'first')));
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    const before = await waitForRows(pg.handle.db, pr.id, (r) => r.length === 2);
    await app.close();

    const app2 = await appWith(
      new UsageOverridingLlm({ costUsd: 0.005 }, fixtureFor(paths, 'second')),
    );
    await app2.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/file-summaries`,
      payload: { force: true },
    });
    await app2.container.jobs.onIdle();
    const after = await waitForRows(pg.handle.db, pr.id, (r) =>
      r.every((row) => row.summary.includes('second')),
    );

    // Same three-column key ⇒ still two rows, updated in place.
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.summary.includes('second'))).toBe(true);
    expect(after.reduce((n, r) => n + (r.costUsd ?? 0), 0)).toBe(0.005);
    const oldest = Math.min(...before.map((r) => r.createdAt.getTime()));
    expect(Math.min(...after.map((r) => r.createdAt.getTime()))).toBeGreaterThanOrEqual(oldest);
    // Each row got its OWN new values, not one row's values written over both.
    const byPath = new Map(after.map((r) => [r.path, r]));
    expect(byPath.get('src/config.ts')!.summary).toContain('src/config.ts');
    expect(byPath.get('src/api/users.ts')!.summary).toContain('src/api/users.ts');
    await app2.close();
  });

  // ----------------------------------------------------------- the whole table

  it('a cascade delete of the PR removes its summaries', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/file-summaries`, payload: {} });
    await app.container.jobs.onIdle();
    await waitForRows(pg.handle.db, pr.id, (r) => r.length === 1);
    await app.close();

    await pg.handle.db.delete(t.pullRequests).where(eq(t.pullRequests.id, pr.id));

    const rows = await pg.handle.db
      .select()
      .from(t.prFileSummaries)
      .where(and(eq(t.prFileSummaries.prId, pr.id)));
    expect(rows).toEqual([]);
  });
});
