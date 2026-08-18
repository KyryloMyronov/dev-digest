import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns, waitForTrace } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { Review } from '@devdigest/shared';
import { intentLlm } from './helpers/intent.js';

/**
 * L03 — the intent layer against a real Postgres.
 *
 * The unit suite covers the pipeline's decisions; what only a database can prove
 * is the round trip: that every new `pr_intent` column survives a write and a
 * read, that a re-derivation overwrites in place (PK = pr_id) and moves
 * `created_at`, and that a real review run threads the derived block all the way
 * into the persisted trace.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const DIFF = `diff --git a/src/sync.ts b/src/sync.ts
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  retries: 5,
   redisUrl: x,`;

const REVIEW_FIXTURE: Review = {
  verdict: 'comment',
  summary: 'Looks fine.',
  score: 80,
  findings: [],
};

const INTENT_FIXTURE = {
  intent: 'The nightly sync dies whenever upstream rate-limits; make it retry instead.',
  change_type: 'bugfix',
  in_scope: ['retry with backoff on 429'],
  out_of_scope: ['changing the sync schedule'],
  confidence: 0.95,
  evidence: ['pr-body'],
};

let repoSeq = 0;
async function setupRepoAndPr(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  body: string | null,
) {
  const name = `sync-service-${repoSeq++}`;
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
      title: 'Retry the nightly sync on 429',
      author: 'octocat',
      branch: 'fix/sync-retry',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body,
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/sync.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  retries: 5,\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

/**
 * `POST /pulls/:id/intent` is a 202 job receipt, not a result — the derivation
 * runs on JobRunner. Poll `pr_intent` until the row satisfies `pred`, the way a
 * client polls the endpoint.
 */
async function waitForIntentRow(
  db: PgFixture['handle']['db'],
  prId: string,
  pred: (row: typeof t.prIntent.$inferSelect) => boolean = () => true,
  timeoutMs = 10_000,
) {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    if (row && pred(row)) return row;
    if (Date.now() - start > timeoutMs) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A body long enough to count as documentation (so confidence is not capped). */
const DOCUMENTED_BODY =
  'The nightly sync gives up as soon as the upstream API rate-limits us, which means a manual re-run every other morning. ' +
  'This adds a bounded exponential backoff so a 429 is retried instead of failing the whole job. ' +
  'It deliberately does not touch the schedule itself.';

d('L03 intent layer (Testcontainers pg)', () => {
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

  function appWith() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: {
          // The agent's own model…
          openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
          // …and the SEPARATE cheap model the intent layer resolves. Overriding
          // only `openai` here would let the intent call reach a real provider.
          openrouter: intentLlm(INTENT_FIXTURE),
        },
      },
    });
  }

  it('GET /pulls/:id/intent is null before anything derived it', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, DOCUMENTED_BODY);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await app.close();
  });

  it('POST /pulls/:id/intent queues a derivation that persists every column', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, DOCUMENTED_BODY);

    const res = await app.inject({ method: 'POST', url: `/pulls/${pr.id}/intent` });
    // 202 + a job receipt — the derivation is NOT awaited in the request.
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('accepted');
    expect(res.json().jobId).toBeTruthy();

    const row = await waitForIntentRow(pg.handle.db, pr.id);
    expect(row!.changeType).toBe('bugfix');
    expect(row!.confidence).toBe(0.95);
    expect(row!.sources).toEqual(expect.arrayContaining(['title', 'pr_body', 'branch']));
    expect(row!.headSha).toBe('a1b2c3d4');
    expect(row!.tokensIn).toBeGreaterThan(0);
    expect(row!.createdAt).toBeInstanceOf(Date);

    // The GET is what the client actually reads while it polls.
    const read = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` });
    expect(read.statusCode).toBe(200);
    expect(read.json().intent).toContain('nightly sync');
    expect(read.json().derived_from).toBe('documented');
    expect(read.json().model).toBeTruthy();
    await app.close();
  });

  it('re-derivation overwrites in place and moves created_at', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, DOCUMENTED_BODY);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/intent` });
    const first = await waitForIntentRow(pg.handle.db, pr.id);

    await new Promise((r) => setTimeout(r, 15));
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/intent` });
    // Wait for the SECOND derivation specifically — the row already exists, so
    // "a row is present" would be satisfied by the first one immediately.
    await waitForIntentRow(
      pg.handle.db,
      pr.id,
      (row) => row.createdAt.getTime() > first!.createdAt.getTime(),
    );

    const rows = await pg.handle.db.select().from(t.prIntent).where(eq(t.prIntent.prId, pr.id));
    // PK is pr_id: one row, overwritten — never a second row.
    expect(rows).toHaveLength(1);
    // `created_at` means "last derived at"; the column default only fires on
    // insert, so this is what proves the conflict branch sets it explicitly.
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(first!.createdAt.getTime());
    await app.close();
  });

  it('caps confidence when the PR has no description', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, null);

    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/intent` });
    await waitForIntentRow(pg.handle.db, pr.id);

    const record = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` })).json();
    // The model reported 0.95; with no documentation it may not sound sure.
    expect(record.derived_from).toBe('indirect');
    expect(record.confidence).toBe(0.45);
    expect(record.sources).not.toContain('pr_body');
    await app.close();
  });

  it('a review run derives the intent once and lands it in the persisted trace', async () => {
    const app = await appWith();
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, DOCUMENTED_BODY);

    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Rev', provider: 'openai', model: 'gpt-4.1', system_prompt: 'review' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/review`,
      payload: { agentId: agent.id },
    });
    expect(res.statusCode).toBe(200);
    const runId = res.json().runs[0].run_id;

    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    // Run status goes terminal BEFORE the trace is written — polling on status
    // alone races that window (server/insights.md 2026-08-11).
    await waitForTrace(pg.handle.db, runId);

    const trace = (await app.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
    expect(trace.prompt_assembly.intent).toContain('Intent:');
    expect(trace.prompt_assembly.user).toContain('## PR intent (derived)');
    expect(trace.prompt_assembly.user).toContain('<untrusted source="derived-intent">');
    expect(trace.tool_calls.some((c: { tool: string }) => c.tool === 'derive_intent')).toBe(true);
    expect(trace.log.some((l: { msg: string }) => l.msg.includes('Deriving PR intent'))).toBe(true);

    // The run also persisted the intent, so a second review is free.
    const stored = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/intent` })).json();
    expect(stored.head_sha).toBe('a1b2c3d4');
    await app.close();
  });
});
