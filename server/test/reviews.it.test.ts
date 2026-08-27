import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns, waitForTrace } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { Review } from '@devdigest/shared';
import type { ProjectContext } from '../src/modules/project-context/types.js';
import { intentLlm } from './helpers/intent.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * A unified diff touching src/config.ts (line 11 added) so grounding can keep a
 * finding on line 11 and drop one on line 999 / a non-existent file.
 */
const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

/** A Review fixture: one valid finding (line 11), one hallucinated (line 999). */
const REVIEW_FIXTURE: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded Stripe secret introduced.',
  score: 42,
  findings: [
    {
      id: 'f-valid',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live Stripe key is committed in source.',
      suggestion: 'Move the key to an environment variable.',
      confidence: 0.95,
      kind: 'finding',
    },
    {
      id: 'f-halluc',
      severity: 'WARNING',
      category: 'bug',
      title: 'Phantom finding on a line not in the diff',
      file: 'src/config.ts',
      start_line: 999,
      end_line: 999,
      rationale: 'This line does not exist in the diff.',
      confidence: 0.5,
      kind: 'finding',
    },
  ],
};

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
      title: 'Add rate limiting',
      author: 'marisa.koch',
      branch: 'feat/rl',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: 'Add rate limiting. Closes #471.',
    })
    .returning();
  // persist the patch so the reviewer can reconstruct a diff (MockGit also returns one)
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

d('A2 reviews + agents (Testcontainers pg)', () => {
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

  function appWith(structured: unknown, provider: 'openai' | 'anthropic' = 'openai') {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: {
          [provider]: new MockLLMProvider(provider, { structured }),
          // L03 — every review derives the PR intent first, on the
          // `review_intent` feature model (openrouter by default). Without this
          // the call would resolve a real provider. See test/helpers/intent.ts.
          openrouter: intentLlm(),
        },
      },
    });
  }

  it('agents CRUD', async () => {
    const app = await appWith(REVIEW_FIXTURE);

    const created = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Test Reviewer',
        provider: 'openai',
        model: 'gpt-4.1',
        system_prompt: 'You are a reviewer.',
      },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.version).toBe(1);

    const list = (await app.inject({ method: 'GET', url: '/agents' })).json();
    expect(list.some((a: { id: string }) => a.id === agent.id)).toBe(true);

    // a config change bumps version
    const updated = (
      await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}`,
        payload: { system_prompt: 'Updated prompt.' },
      })
    ).json();
    expect(updated.version).toBe(2);

    await app.close();
  });

  it('runs a review: map-reduce + grounding drops the hallucinated finding, keeps the valid one', async () => {
    const app = await appWith(REVIEW_FIXTURE);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Sec', provider: 'openai', model: 'gpt-4.1', system_prompt: 'sec' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/review`,
      payload: { agentId: agent.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);

    // runReview is fire-and-forget: wait for the background run, then read the
    // persisted reviews (the POST returns runIds, not the reviews themselves).
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    const reviews = (
      await app.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })
    ).json();
    expect(reviews).toHaveLength(1);

    const review = reviews[0];
    expect(review.verdict).toBe('request_changes');
    // Score is derived from the GROUNDED findings, not the model's self-reported
    // 42: grounding keeps one CRITICAL (line 11) ⇒ 100 − 35 = 65.
    expect(review.score).toBe(65);
    // grounding kept only the valid finding (line 11), dropped the line-999 one
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].file).toBe('src/config.ts');
    expect(review.findings[0].start_line).toBe(11);

    // a run_traces document was written (single doc)
    const runId = body.runs[0].run_id;
    const trace = (await app.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
    expect(trace.config.model).toBe('gpt-4.1');
    expect(trace.stats.grounding).toBe('1/2 passed');
    expect(trace.log.length).toBeGreaterThan(0);

    // agent_runs row populated for A5 to aggregate
    const [run] = await pg.handle.db.select().from(t.agentRuns).where(eq(t.agentRuns.id, runId));
    expect(run!.status).toBe('done');
    expect(run!.findingsCount).toBe(1);
    expect(run!.grounding).toBe('1/2 passed');

    await app.close();
  });

  it('dual-provider structured output: anthropic provider returns the same Review shape', async () => {
    const app = await appWith(REVIEW_FIXTURE, 'anthropic');
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Claude Rev', provider: 'anthropic', model: 'claude-x', system_prompt: 'rev' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } });
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    const reviews = (
      await app.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })
    ).json();
    expect(reviews[0].findings).toHaveLength(1);
    expect(reviews[0].model).toBe('claude-x');
    await app.close();
  });

  it('finding actions: accept, dismiss', async () => {
    const app = await appWith(REVIEW_FIXTURE);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'ActAgent', provider: 'openai', model: 'gpt-4.1', system_prompt: 's' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } });
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    const reviews = (
      await app.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })
    ).json();
    const findingId = reviews[0].findings[0].id;

    const accepted = (
      await app.inject({ method: 'POST', url: `/findings/${findingId}/accept` })
    ).json();
    expect(accepted.finding.accepted_at).not.toBeNull();

    const dismissed = (
      await app.inject({ method: 'POST', url: `/findings/${findingId}/dismiss` })
    ).json();
    expect(dismissed.finding.dismissed_at).not.toBeNull();
    expect(dismissed.finding.accepted_at).toBeNull();

    await app.close();
  });

  it('SSE: /runs/:id/events streams events and completes', async () => {
    const app = await appWith(REVIEW_FIXTURE);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'SseAgent', provider: 'openai', model: 'gpt-4.1', system_prompt: 's' },
      })
    ).json();
    // The run is synchronous; events are buffered on the bus. Subscribing after
    // the run still replays the buffer (replay-first semantics), then completes.
    const body = (
      await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } })
    ).json();
    const runId = body.runs[0].run_id;

    const sse = await app.inject({ method: 'GET', url: `/runs/${runId}/events` });
    expect(sse.statusCode).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    // The replay buffer should contain our log lines as SSE `data:` frames.
    expect(sse.payload).toContain('Starting review');
    expect(sse.payload).toContain('Citation grounding');
    await app.close();
  });

  it('run all enabled agents reviews with each enabled agent', async () => {
    const app = await appWith(REVIEW_FIXTURE);
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const body = (
      await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { all: true } })
    ).json();
    // seed has 2 enabled agents; we may have created more above in this PR's ws.
    expect(body.runs.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  // ------------------------- SPEC-01: project context on the run path -------
  //
  // The run half of SPEC-01: AC-41 (the engine's `specs` input), AC-43/44 (an
  // unreadable document), AC-46, AC-47 (a throwing facade), AC-48 (a resolution
  // that expired), AC-50 (the key omitted) and AC-51 (`specs_read`), plus
  // NFR-10 (no document body in any log line).
  //
  // Attachments are inserted DIRECTLY here: the attach route validates every
  // path against a real clone walk, which `project-context.it.test.ts` covers.
  // This suite is about what the executor does with rows that already exist.
  describe('project context (SPEC-01)', () => {
    const DOCS = {
      'specs/public-api.md': 'AUTH-IS-REQUIRED-ON-EVERY-ENDPOINT',
      'docs/adr/0004-caching.md': 'CACHE-READS-FOR-30-SECONDS',
    };

    function appWithGit(git: MockGitClient) {
      return buildApp({
        config: config(),
        db: pg.handle.db,
        overrides: {
          embedder: new MockEmbedder(),
          git,
          llm: {
            openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
            openrouter: intentLlm(),
          },
        },
      });
    }

    async function makeAgent(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
      return (
        await app.inject({
          method: 'POST',
          url: '/agents',
          payload: { name, provider: 'openai', model: 'gpt-4.1', system_prompt: 'sec' },
        })
      ).json();
    }

    async function runAndTrace(
      app: Awaited<ReturnType<typeof buildApp>>,
      prId: string,
      agentId: string,
    ) {
      const body = (
        await app.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { agentId } })
      ).json();
      const runId = body.runs[0].run_id;
      await waitForPrRuns(pg.handle.db, prId, { expected: 1 });
      // MANDATORY before reading a trace: the executor marks the run terminal
      // BEFORE persisting the trace, so polling on run status alone races a
      // ~45-line window and reads a 404 (server/insights.md, 2026-08-11).
      await waitForTrace(pg.handle.db, runId);
      const trace = (await app.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
      const [run] = await pg.handle.db
        .select()
        .from(t.agentRuns)
        .where(eq(t.agentRuns.id, runId));
      return { runId, trace, run: run! };
    }

    // AC-41 + AC-51 + AC-60 end-to-end, and NFR-10.
    it('injects the attached documents, records their paths, and logs no body', async () => {
      const git = new MockGitClient({ diff: DIFF, files: DOCS });
      const app = await appWithGit(git);
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = await makeAgent(app, 'Ctx Sec');

      await pg.handle.db.insert(t.agentContextDocs).values([
        { workspaceId, agentId: agent.id, path: 'specs/public-api.md', order: 0 },
        { workspaceId, agentId: agent.id, path: 'docs/adr/0004-caching.md', order: 1 },
      ]);

      const { trace, run } = await runAndTrace(app, pr.id, agent.id);

      expect(run.status).toBe('done');
      // AC-41 + AC-42 + AC-60 — the documents reached the engine's `specs` slot
      // and each block is fenced under its own path.
      expect(trace.prompt_assembly.specs).toContain('<untrusted source="specs/public-api.md">');
      expect(trace.prompt_assembly.specs).toContain('AUTH-IS-REQUIRED-ON-EVERY-ENDPOINT');
      expect(trace.prompt_assembly.specs).toContain(
        '<untrusted source="docs/adr/0004-caching.md">',
      );
      expect(trace.prompt_assembly.user).toContain('## Project context');
      // AC-51 — every injected path, in prompt order.
      expect(trace.specs_read).toEqual(['specs/public-api.md', 'docs/adr/0004-caching.md']);
      expect(trace.specs_skipped).toEqual([]);

      // NFR-10 — the Live Log names the PATHS and never the bodies.
      const log = (trace.log as { msg: string }[]).map((l) => l.msg);
      expect(log.some((m) => m.includes('Project context attached (2)'))).toBe(true);
      for (const body of Object.values(DOCS)) {
        expect(log.some((m) => m.includes(body))).toBe(false);
      }

      await pg.handle.db.delete(t.agentContextDocs);
      await app.close();
    });

    // AC-43 + AC-44 — an unreadable document is skipped with a reason and named
    // in the Live Log; the rest of the context still reaches the prompt.
    it('records an unreadable document as skipped and names it in the log', async () => {
      class ThrowingGit extends MockGitClient {
        override async readFile(repo: { owner: string; name: string }, path: string) {
          if (path === 'specs/deleted.md') throw new Error('ENOENT: no such file');
          return super.readFile(repo, path);
        }
      }
      const app = await appWithGit(new ThrowingGit({ diff: DIFF, files: DOCS }));
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = await makeAgent(app, 'Ctx Unread');

      await pg.handle.db.insert(t.agentContextDocs).values([
        { workspaceId, agentId: agent.id, path: 'specs/deleted.md', order: 0 },
        { workspaceId, agentId: agent.id, path: 'specs/public-api.md', order: 1 },
      ]);

      const { trace, run } = await runAndTrace(app, pr.id, agent.id);

      expect(run.status).toBe('done');
      expect(trace.specs_read).toEqual(['specs/public-api.md']);
      expect(trace.specs_skipped).toEqual([{ path: 'specs/deleted.md', reason: 'unread' }]);
      const log = (trace.log as { msg: string }[]).map((l) => l.msg);
      expect(
        log.some((m) => m.includes('unreadable') && m.includes('specs/deleted.md')),
      ).toBe(true);

      await pg.handle.db.delete(t.agentContextDocs);
      await app.close();
    });

    // AC-47 + AC-50 — a facade that throws must not fail the run, and the
    // `specs` key is OMITTED rather than sent empty, so the prompt is
    // byte-identical to the no-context baseline.
    it('completes the run with no project context when the facade throws (AC-47)', async () => {
      const throwing: ProjectContext = {
        resolveForRun: async () => {
          throw new Error('project-context exploded');
        },
      };
      const app = await buildApp({
        config: config(),
        db: pg.handle.db,
        overrides: {
          embedder: new MockEmbedder(),
          git: new MockGitClient({ diff: DIFF, files: DOCS }),
          projectContext: throwing,
          llm: {
            openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
            openrouter: intentLlm(),
          },
        },
      });
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = await makeAgent(app, 'Ctx Throwing');
      await pg.handle.db
        .insert(t.agentContextDocs)
        .values({ workspaceId, agentId: agent.id, path: 'specs/public-api.md', order: 0 });

      const { trace, run } = await runAndTrace(app, pr.id, agent.id);

      expect(run.status).toBe('done');
      expect(trace.prompt_assembly.specs ?? null).toBeNull();
      expect(trace.prompt_assembly.user).not.toContain('## Project context');
      expect(trace.specs_read).toEqual([]);
      expect(trace.specs_skipped).toEqual([]);

      await pg.handle.db.delete(t.agentContextDocs);
      await app.close();
    });

    /**
     * AC-48 — a resolution that ran out of wall clock leaves the run with no
     * project context.
     *
     * The facade OWNS the timeout by design (`PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS`,
     * raced inside `resolver.ts`), so a mock that hangs forever would hang the
     * run rather than exercise anything — the executor deliberately has no
     * competing timer. What is asserted here is the executor-visible OUTCOME of
     * an expiry: a slow facade that returns the empty result the real one returns
     * on timeout. The timeout itself is proven hermetically in
     * `resolver.test.ts` ("abandons a slow resolution and returns no context").
     */
    it('completes the run with no project context when resolution expired (AC-48)', async () => {
      const expired: ProjectContext = {
        resolveForRun: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { texts: [], injected: [], skipped: [] };
        },
      };
      const app = await buildApp({
        config: config(),
        db: pg.handle.db,
        overrides: {
          embedder: new MockEmbedder(),
          git: new MockGitClient({ diff: DIFF, files: DOCS }),
          projectContext: expired,
          llm: {
            openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
            openrouter: intentLlm(),
          },
        },
      });
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = await makeAgent(app, 'Ctx Slow');
      await pg.handle.db
        .insert(t.agentContextDocs)
        .values({ workspaceId, agentId: agent.id, path: 'specs/public-api.md', order: 0 });

      const { trace, run } = await runAndTrace(app, pr.id, agent.id);

      expect(run.status).toBe('done');
      expect(trace.prompt_assembly.specs ?? null).toBeNull();
      expect(trace.specs_read).toEqual([]);

      await pg.handle.db.delete(t.agentContextDocs);
      await app.close();
    });

    // AC-46 — every document dropped at the token ceiling is named in the log
    // and recorded with reason `budget`. Driven through the real facade with a
    // body large enough to bust the 8 000-token budget on its own.
    it('names every document excluded at the token budget (AC-46)', async () => {
      const huge = 'x '.repeat(20_000); // ≈ 20 000 tokens
      const app = await appWithGit(
        new MockGitClient({
          diff: DIFF,
          files: { 'specs/huge.md': huge, 'specs/public-api.md': DOCS['specs/public-api.md'] },
        }),
      );
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = await makeAgent(app, 'Ctx Budget');
      await pg.handle.db.insert(t.agentContextDocs).values([
        { workspaceId, agentId: agent.id, path: 'specs/huge.md', order: 0 },
        { workspaceId, agentId: agent.id, path: 'specs/public-api.md', order: 1 },
      ]);

      const { trace, run } = await runAndTrace(app, pr.id, agent.id);

      expect(run.status).toBe('done');
      expect(trace.specs_read).toEqual([]);
      expect(trace.specs_skipped).toEqual([
        { path: 'specs/huge.md', reason: 'budget' },
        { path: 'specs/public-api.md', reason: 'budget' },
      ]);
      const log = (trace.log as { msg: string }[]).map((l) => l.msg);
      expect(
        log.some(
          (m) =>
            m.includes('over budget') &&
            m.includes('specs/huge.md') &&
            m.includes('specs/public-api.md'),
        ),
      ).toBe(true);
      // NFR-10 again, on the skip path.
      expect(log.some((m) => m.includes(huge.slice(0, 40)))).toBe(false);

      await pg.handle.db.delete(t.agentContextDocs);
      await app.close();
    });
  });
});
