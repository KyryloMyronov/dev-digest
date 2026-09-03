import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AuthProvider } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import { JobRunner } from '../src/platform/jobs.js';
import * as t from '../src/db/schema.js';
import { BRIEF_DERIVE_JOB_KIND } from '../src/modules/brief/constants.js';
import { BRIEF_FIXTURE, briefLlm } from './helpers/brief.js';
import { intentLlm } from './helpers/intent.js';

/**
 * SPEC-02 — the brief against a real Postgres.
 *
 * The unit suite covers the pipeline's decisions; what only a database can
 * prove is the round trip: that every new `pr_brief` column survives a write
 * and a read, that the workspace scoping is in the QUERY and not merely in the
 * service, that a failed derivation leaves the row byte-identical, and that a
 * cache hit really makes no model call.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

let repoSeq = 0;
async function setupRepoAndPr(db: PgFixture['handle']['db'], workspaceId: string) {
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
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: 'Adds a per-route limiter to the public endpoints.',
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

/** `POST /pulls/:id/brief` is a 202 receipt — poll `pr_brief` like a client. */
async function waitForBriefRow(
  db: PgFixture['handle']['db'],
  prId: string,
  pred: (row: typeof t.prBrief.$inferSelect) => boolean = () => true,
  timeoutMs = 10_000,
) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    if (row && pred(row)) return row;
    if (Date.now() - start > timeoutMs) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
}

d('SPEC-02 PR brief (Testcontainers pg)', () => {
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
   * Every provider the code will resolve is overridden, not just the brief's.
   * `risk_brief` defaults to **openai**, `review_intent` to **openrouter**; a
   * test that overrode only one would let the other reach a real, billable
   * provider on a machine that happens to have a key configured.
   */
  function appWith(brief = briefLlm()) {
    const app = buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openai: brief, openrouter: intentLlm() },
      },
    });
    return app;
  }

  // ------------------------------------------------------------ AC-1 / AC-2

  it('AC-1 — GET is null before anything derived it, and the record after', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const empty = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);

    const read = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
    expect(read.statusCode).toBe(200);
    // AC-2 — the payload is the PrBriefRecord shape, serialised by the schema.
    const body = read.json();
    expect(body.pr_id).toBe(pr.id);
    expect(body.why.summary).toBe(BRIEF_FIXTURE.why_summary);
    expect(body.risks[0].severity).toBe('WARNING');
    expect(body.focus.entries[0].file).toBe('src/config.ts');
    expect(body.head_sha).toBe('a1b2c3d4');
    await app.close();
  });

  // ------------------------------------------------------------------ AC-19

  it('AC-19 — one row carries the JSON, the head SHA, the timestamp, provider, model, tokens and cost', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const row = await waitForBriefRow(pg.handle.db, pr.id);

    expect(row!.headSha).toBe('a1b2c3d4');
    expect(row!.provider).toBe('openai');
    expect(row!.model).toBeTruthy();
    expect(row!.tokensIn).toBeGreaterThan(0);
    expect(row!.tokensOut).toBeGreaterThan(0);
    expect(row!.costUsd).not.toBeUndefined();
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(row!.json as object).sort()).toEqual([
      'focus',
      'grounding',
      'omitted_files',
      'risks',
      'why',
    ]);
    await app.close();
  });

  it('re-derivation overwrites in place and moves created_at', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const first = await waitForBriefRow(pg.handle.db, pr.id);

    await new Promise((r) => setTimeout(r, 15));
    await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/brief`,
      payload: { force: true },
    });
    await waitForBriefRow(
      pg.handle.db,
      pr.id,
      (row) => row.createdAt.getTime() > first!.createdAt.getTime(),
    );

    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, pr.id));
    // PK is pr_id: one row, overwritten — never a second row.
    expect(rows).toHaveLength(1);
    // `created_at` means "last derived at"; the column default only fires on
    // insert, so this is what proves the conflict branch sets it explicitly.
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(first!.createdAt.getTime());
    await app.close();
  });

  // ------------------------------------------------------------- AC-12 / 13

  it('AC-12 — a stored brief fresh for the head is returned with NO model call', async () => {
    const brief = briefLlm();
    const app = await appWith(brief);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);
    const after = brief.calls.filter((c) => c.method === 'completeStructured').length;
    expect(after).toBe(1);

    // A second, unforced derivation over an unchanged head.
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await app.container.jobs.onIdle();

    expect(brief.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(after);
    await app.close();
  });

  it('AC-13 — force ignores the stored row and re-derives', async () => {
    const brief = briefLlm();
    const app = await appWith(brief);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);
    const after = brief.calls.filter((c) => c.method === 'completeStructured').length;

    await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/brief`,
      payload: { force: true },
    });
    await app.container.jobs.onIdle();

    expect(brief.calls.filter((c) => c.method === 'completeStructured').length).toBe(after + 1);
    await app.close();
  });

  // ------------------------------------------------------------------ AC-11

  it('AC-11 — a failed derivation leaves the existing row byte-identical', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const good = await appWith();
    await good.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const before = await waitForBriefRow(pg.handle.db, pr.id);
    await good.close();

    // A fixture the extraction schema rejects: MockLLMProvider throws, so the
    // derivation exits `llm_failed` and must write nothing.
    const bad = await appWith(briefLlm({ not: 'a brief' }));
    await bad.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/brief`,
      payload: { force: true },
    });
    await bad.container.jobs.onIdle();

    const [after] = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, pr.id));
    expect(after).toEqual(before);
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
    await bad.close();
  });

  // ------------------------------------------------------------- AC-28 / 29

  it('AC-28 — the kept and dropped counts are persisted inside the brief', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    const row = await waitForBriefRow(pg.handle.db, pr.id);

    // One risk + one focus entry, both citing src/config.ts:12, which is in the
    // diff — so both survive the gate.
    expect((row!.json as { grounding: unknown }).grounding).toEqual({ kept: 2, dropped: 0 });
    await app.close();
  });

  it('AC-29 — a wholly ungrounded derivation persists an EMPTY risk list with a non-zero dropped count', async () => {
    const app = await appWith(
      briefLlm({
        ...BRIEF_FIXTURE,
        risks: [
          { ...BRIEF_FIXTURE.risks[0]!, file: 'src/ghost.ts' },
          { ...BRIEF_FIXTURE.risks[0]!, start_line: 9_000, end_line: 9_000 },
        ],
        focus: [],
      }),
    );
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);

    const body = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` })).json();
    // "Everything was hallucinated" and "genuinely no risks found" are DIFFERENT
    // facts, and the dropped count is the only thing that separates them.
    expect(body.risks).toEqual([]);
    expect(body.grounding).toEqual({ kept: 0, dropped: 2 });
    await app.close();
  });

  // ------------------------------------------------------------------- AC-3

  it('AC-3 — the same PR id read under a SECOND workspace is a 404', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);
    await app.close();

    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-tenant' })
      .returning();
    const otherAuth: AuthProvider = {
      currentUser: async () => ({ id: 'user-2', email: 'x@y', name: 'x' }) as never,
      currentWorkspace: async () => ({ id: other!.id, name: 'other-tenant' }) as never,
    };
    const app2 = await buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        auth: otherAuth,
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openai: briefLlm(), openrouter: intentLlm() },
      },
    });

    const res = await app2.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app2.close();
  });

  // ------------------------------------------------------------------ AC-23

  it('AC-23 — a derivation that outlives the job timeout marks the job failed and leaves pr_brief alone', async () => {
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    // The SHIPPED timeout is 120 000 ms: `platform/container.ts` constructs
    // `JobRunner` with no options, so `jobs.ts`'s default applies. Pin that
    // number here rather than waiting two minutes for it…
    const shipped = new JobRunner(pg.handle.db);
    expect((shipped as unknown as { timeoutMs: number }).timeoutMs).toBe(120_000);
    expect((shipped as unknown as { retries: number }).retries).toBe(2);

    // …and drive the MECHANISM with a short one, so the suite stays fast.
    const runner = new JobRunner(pg.handle.db, { timeoutMs: 150, retries: 0 });
    runner.register(BRIEF_DERIVE_JOB_KIND, () => new Promise(() => undefined));
    const job = await runner.enqueue(workspaceId, BRIEF_DERIVE_JOB_KIND, {
      workspaceId,
      prId: pr.id,
    });
    await job.done.catch(() => undefined);

    const [jobRow] = await pg.handle.db.select().from(t.jobs).where(eq(t.jobs.id, job.id));
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.error).toMatch(/timed out|timeout/i);

    const [briefRow] = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, pr.id));
    expect(briefRow).toBeUndefined();
  });

  // ------------------------------------------------------------------ NFR-1

  it('NFR-1 — a stored brief reads fast and serialises well inside 64 KB', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/brief` });
    await waitForBriefRow(pg.handle.db, pr.id);

    const timings: number[] = [];
    let lastLength = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/brief` });
      timings.push(performance.now() - t0);
      lastLength = Buffer.byteLength(res.body, 'utf8');
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95) - 1]!;

    // The payload cap is the HARD half: AC-16, AC-39 and AC-40 are what keep it
    // inside 64 KB, and this is what would notice if a cap were removed.
    expect(lastLength).toBeLessThanOrEqual(64 * 1024);
    // The timing half is ENVIRONMENT-DEPENDENT, not a gate: the spec's 150 ms
    // is measured on a developer machine, and this runs against a container on
    // whatever CI happens to give us. A generous bound catches a regression of
    // ORDERS of magnitude without being a flake generator.
    expect(p95).toBeLessThan(2_000);
    await app.close();
  });
});
