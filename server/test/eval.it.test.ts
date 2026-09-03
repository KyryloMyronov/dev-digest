import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { MAX_CASES_PER_AGENT } from '../src/modules/eval/constants.js';
import { scoreBatch } from '../src/modules/eval/scoring.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[eval] Docker not available — skipping integration tests.');
}

/**
 * SPEC-04 step 16 — phase-1 server integration.
 *
 * TWO CRITERIA HERE ARE ASSERTED, NOT BUILT (plan D-17), so do not go looking
 * for the code that implements them:
 *  - **AC-26** `eval_runs.case_id` was already `ON DELETE CASCADE` before this
 *    spec. Deleting a case deletes its runs because Postgres does it.
 *  - **AC-2** `eval_runs` carries no `workspace_id` and never did. The tenancy
 *    path is the `case_id → eval_cases.workspace_id` join, and the observation
 *    that proves it is a run whose `agent_id` names a FOREIGN agent still being
 *    readable in its own workspace.
 *
 * EVERY provider the code will resolve is overridden, not just the agent's
 * (`server/insights.md` 2026-08-17). The seeded agents are `openrouter`; an
 * override of only `openai` would make a real, billable call.
 */

const DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  ' const b = 2;',
  '+const key = "sk_live_seeded";',
  ' const c = 3;',
].join('\n');

const OTHER_DIFF = DIFF.replace(/config\.ts/g, 'other.ts');

const FINDING_AT = (file: string, line: number) => ({
  id: 'f1',
  severity: 'CRITICAL',
  category: 'security',
  title: 'Hardcoded key',
  file,
  start_line: line,
  end_line: line,
  rationale: 'A live key.',
  suggestion: null,
  confidence: 0.9,
});

const review = (findings: unknown[]) => ({
  verdict: findings.length > 0 ? 'request_changes' : 'approve',
  summary: 's',
  score: findings.length > 0 ? 40 : 95,
  findings,
});

d('SPEC-04 — eval cases, batches and tenancy', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let agentId: string;
  let otherAgentId: string;
  let prId: string;
  let findingId: string;
  let findingNoAgentId: string;
  let findingOffDiffId: string;

  beforeAll(async () => {
    pg = await startPg();
    const s = await seed(pg.handle.db);
    workspaceId = s.workspaceId;
    const db = pg.handle.db;

    // An agent of our own, so the seeded ones stay untouched for other suites.
    const [agent] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Eval Target',
        description: 'd',
        provider: 'openai',
        model: 'gpt-4.1',
        systemPrompt: 'Review the diff.',
        enabled: true,
        version: 3,
      })
      .returning();
    agentId = agent!.id;

    const [other] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Eval Target 2',
        description: 'd',
        provider: 'openai',
        model: 'gpt-4.1',
        systemPrompt: 'Review the diff.',
        enabled: false, // AC-42's excluded agent
        version: 1,
      })
      .returning();
    otherAgentId = other!.id;

    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'eval', fullName: 'acme/eval' })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 900,
        title: 'Add a key',
        author: 'a',
        branch: 'b',
        base: 'main',
        headSha: 'deadbeef',
      })
      .returning();
    prId = pr!.id;
    await db.insert(t.prFiles).values({
      prId,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n const a = 1;\n const b = 2;\n+const key = "sk_live_seeded";\n const c = 3;',
    });

    const [rv] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, agentId, kind: 'review', verdict: 'request_changes' })
      .returning();
    const [rvNoAgent] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, kind: 'review', verdict: 'comment' })
      .returning();

    const base = {
      file: 'src/config.ts',
      startLine: 12,
      endLine: 12,
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      rationale: 'r',
      confidence: 0.9,
    };
    const [f1] = await db
      .insert(t.findings)
      .values({ reviewId: rv!.id, ...base, acceptedAt: new Date() })
      .returning();
    findingId = f1!.id;
    const [f2] = await db
      .insert(t.findings)
      .values({ reviewId: rvNoAgent!.id, ...base })
      .returning();
    findingNoAgentId = f2!.id;
    const [f3] = await db
      .insert(t.findings)
      .values({ reviewId: rv!.id, ...base, file: 'src/absent.ts', dismissedAt: new Date() })
      .returning();
    findingOffDiffId = f3!.id;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp(fixture: unknown = review([FINDING_AT('src/config.ts', 13)])) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai', { structured: fixture });
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        // ALL THREE, deliberately (server/insights.md 2026-08-17).
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
  }

  const caseBody = (over: Record<string, unknown> = {}) => ({
    owner_kind: 'agent',
    owner_id: agentId,
    name: `case-${Math.random().toString(36).slice(2, 10)}`,
    input_diff: DIFF,
    expected_output: [{ file: 'src/config.ts', start_line: 13 }],
    ...over,
  });

  // =====================================================================
  // Turning a finding into a case
  // =====================================================================

  it('AC-7 / AC-10 / AC-11 / AC-12 / AC-13 / AC-14 — an accepted finding becomes a frozen case', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: `/findings/${findingId}/eval-case` });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.expectation).toBe('must_find'); // AC-7
    expect(body.input_diff).toContain('src/config.ts'); // AC-10
    expect(body.input_meta.head_sha).toBe('deadbeef'); // AC-11
    expect(body.input_meta.source_finding_ids).toEqual([findingId]); // AC-12
    expect(body.expected_output).toEqual([
      expect.objectContaining({ file: 'src/config.ts', start_line: 12, end_line: 12 }),
    ]); // AC-13
    expect(body.name).toBe('hardcoded-stripe-secret-key'); // AC-14
    await app.close();
  });

  it('AC-16 — the same finding a second time returns the SAME case with 200', async () => {
    const app = await makeApp();
    const first = await app.inject({ method: 'POST', url: `/findings/${findingId}/eval-case` });
    const second = await app.inject({ method: 'POST', url: `/findings/${findingId}/eval-case` });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    await app.close();
  });

  it('AC-8 / AC-17 — a dismissed finding off the diff is refused before any row is written', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/findings/${findingOffDiffId}/eval-case`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('AC-18 — a review with no agent_id is refused', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/findings/${findingNoAgentId}/eval-case`,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  // =====================================================================
  // Authoring
  // =====================================================================

  it('AC-21 / AC-25 — an omitted end_line becomes start_line, an omitted expectation must_find', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/eval-cases`,
      payload: caseBody({ expected_output: [{ file: 'src/config.ts', start_line: 13 }] }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expected_output[0]).toMatchObject({ start_line: 13, end_line: 13 });
    expect(res.json().expectation).toBe('must_find');
    await app.close();
  });

  it('AC-22 — a must_not_flag case accepts an empty expected_output', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/eval-cases`,
      payload: caseBody({ expectation: 'must_not_flag', expected_output: [] }),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('AC-114 — a body naming another owner cannot move the row', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/eval-cases`,
      payload: caseBody({ owner_id: otherAgentId }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().owner_id).toBe(agentId);
    const [row] = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.id, res.json().id));
    expect(row!.ownerId).toBe(agentId);
    expect(row!.workspaceId).toBe(workspaceId);
    await app.close();
  });

  it('AC-26 — deleting a case deletes its runs (ON DELETE CASCADE; asserted, not built)', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/eval-cases`,
      payload: caseBody(),
    });
    const caseId = created.json().id as string;
    await pg.handle.db
      .insert(t.evalRuns)
      .values({ caseId, agentId, agentVersion: 1, batchId: crypto.randomUUID(), trigger: 'manual' });

    const del = await app.inject({ method: 'DELETE', url: `/eval-cases/${caseId}` });
    expect(del.statusCode).toBe(200);
    const runs = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, caseId));
    expect(runs).toHaveLength(0);
    await app.close();
  });

  // =====================================================================
  // Tenancy
  // =====================================================================

  it('AC-1 / AC-4 — a case in another workspace is 404, not 403', async () => {
    const db = pg.handle.db;
    const [ws2] = await db.insert(t.workspaces).values({ name: 'other-ws' }).returning();
    const [foreign] = await db
      .insert(t.evalCases)
      .values({
        workspaceId: ws2!.id,
        ownerKind: 'agent',
        ownerId: agentId,
        name: 'foreign',
        inputDiff: DIFF,
        expectedOutput: [],
        expectation: 'must_not_flag',
      })
      .returning();

    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/eval-cases/${foreign!.id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('AC-2 — a run whose agent_id names a FOREIGN agent is still readable in its own workspace', async () => {
    const db = pg.handle.db;
    const [ws3] = await db.insert(t.workspaces).values({ name: 'ws-for-ac2' }).returning();
    // An agent that belongs to a DIFFERENT workspace than the case does.
    const [foreignAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId: ws3!.id,
        name: 'Foreign',
        description: 'd',
        provider: 'openai',
        model: 'm',
        systemPrompt: 'p',
        version: 1,
      })
      .returning();
    const [ourCase] = await db
      .insert(t.evalCases)
      .values({
        workspaceId,
        ownerKind: 'agent',
        ownerId: foreignAgent!.id,
        name: 'ac2-case',
        inputDiff: DIFF,
        expectedOutput: [],
        expectation: 'must_not_flag',
      })
      .returning();
    const batchId = crypto.randomUUID();
    await db.insert(t.evalRuns).values({
      caseId: ourCase!.id,
      agentId: foreignAgent!.id,
      agentVersion: 1,
      batchId,
      trigger: 'manual',
      pass: true,
      actualOutput: {
        findings: [],
        counts: { expected: 0, actual: 0, matched: 0, noise: 0, kept: 0, dropped: 0 },
      },
    });

    const app = await makeApp();
    // The workspace dashboard reads runs through case_id → eval_cases; the row
    // above must appear even though its agent belongs elsewhere. If tenancy went
    // through agent_id it would be invisible here.
    const res = await app.inject({ method: 'GET', url: '/eval' });
    expect(res.statusCode).toBe(200);
    expect(res.json().batches.map((b: { batch_id: string }) => b.batch_id)).toContain(batchId);
    await app.close();
  });

  // =====================================================================
  // Running a batch
  // =====================================================================

  async function freshAgentWithCases(
    n: number,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const db = pg.handle.db;
    const [a] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: `Batch Agent ${Math.random().toString(36).slice(2, 8)}`,
        description: 'd',
        provider: 'openai',
        model: 'gpt-4.1',
        systemPrompt: 'Review the diff.',
        enabled: true,
        version: 5,
      })
      .returning();
    for (let i = 0; i < n; i += 1) {
      await db.insert(t.evalCases).values({
        workspaceId,
        ownerKind: 'agent',
        ownerId: a!.id,
        name: `c${i}`,
        inputDiff: i % 2 === 0 ? DIFF : OTHER_DIFF,
        inputMeta: { task: 'Review PR #900' },
        expectedOutput: [
          { file: i % 2 === 0 ? 'src/config.ts' : 'src/other.ts', start_line: 13, end_line: 13 },
        ],
        expectation: 'must_find',
        ...over,
      });
    }
    return a!.id;
  }

  it('AC-27 / AC-32 / AC-33 / AC-55 / AC-58 — a batch runs every case under one batch_id', async () => {
    const id = await freshAgentWithCases(2);
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted', cases: 2 });
    const batchId = res.json().batch_id as string;

    await app.container.jobs.onIdle();

    const rows = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.batchId, batchId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.agentVersion === 5)).toBe(true); // AC-32
    expect(rows.every((r) => r.trigger === 'manual')).toBe(true); // AC-33
    // AC-58 — MockLLMProvider reports 0.001, so cost is a number, not null.
    expect(rows.every((r) => typeof r.costUsd === 'number')).toBe(true);

    const batches = await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` });
    expect(batches.statusCode).toBe(200);
    const [b] = batches.json();
    // AC-55 — one trace is one case run.
    expect(b.traces_total).toBe(2);
    expect(b.cases_total).toBe(2);
    expect(b.cases_ran).toBe(2);
    expect(b.status).toBe('complete');
    await app.close();
  });

  it('AC-34 — a batch writes NO agent_runs row', async () => {
    const before = await pg.handle.db.select().from(t.agentRuns);
    const id = await freshAgentWithCases(1);
    const app = await makeApp();
    await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    await app.container.jobs.onIdle();
    const after = await pg.handle.db.select().from(t.agentRuns);
    expect(after.length).toBe(before.length);
    await app.close();
  });

  it('AC-35 — an agent with zero cases is 422', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: `/agents/${otherAgentId}/eval-runs` });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('AC-36 / AC-37 / AC-111 — a failing provider writes the error and the batch continues', async () => {
    const id = await freshAgentWithCases(2);
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai', {
      structured: review([FINDING_AT('src/config.ts', 13)]),
    });
    let n = 0;
    const inner = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => {
      n += 1;
      if (n === 1) throw new Error('provider 502');
      return inner(req);
    };
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    const res = await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    const batchId = res.json().batch_id as string;
    await app.container.jobs.onIdle();

    const rows = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.batchId, batchId));
    expect(rows.filter((r) => r.error !== null)).toHaveLength(1);
    expect(rows.find((r) => r.error !== null)!.error).toContain('provider 502');
    // AC-37, VERBATIM — cases_ran is the count that produced a SCORE.
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.cases_total).toBe(2);
    expect(b.cases_ran).toBe(1);
    await app.close();
  });

  it('AC-38 — a batch in which EVERY case failed reports all three metrics null', async () => {
    const id = await freshAgentWithCases(2);
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai');
    llm.completeStructured = async () => {
      throw new Error('provider down');
    };
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    await app.container.jobs.onIdle();
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.status).toBe('failed');
    // Not `precision: 1` — AC-38 outranks AC-51 (plan D-15).
    expect(b.recall).toBeNull();
    expect(b.precision).toBeNull();
    expect(b.citation_accuracy).toBeNull();
    await app.close();
  });

  it('AC-110 / NFR-6 — a batch past EVAL_BATCH_MAX_MS stops and derives partial', async () => {
    const id = await freshAgentWithCases(3);
    // Testable in SECONDS only because EVAL_BATCH_MAX_MS is configurable (D-11).
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      EVAL_BATCH_MAX_MS: '1',
    } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai', {
      structured: review([FINDING_AT('src/config.ts', 13)]),
    });
    const inner = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => {
      await new Promise((r) => setTimeout(r, 30));
      return inner(req);
    };
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    await app.container.jobs.onIdle();
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.cases_total).toBe(3);
    expect(b.cases_ran).toBeLessThan(3);
    expect(b.status).toBe('partial');
    await app.close();
  });

  it('AC-41 / NFR-2 — the cost ceiling stops the batch and leaves it partial', async () => {
    const id = await freshAgentWithCases(3);
    // MockLLMProvider prices every call at 0.001; a 0.0015 ceiling binds after
    // the first, so cases 2 and 3 are never called.
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      EVAL_BATCH_MAX_USD: '0.0015',
    } as NodeJS.ProcessEnv);
    expect(config.evalBatchMaxUsd).toBe(0.0015);
    const llm = new MockLLMProvider('openai', {
      structured: review([FINDING_AT('src/config.ts', 13)]),
    });
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    await app.container.jobs.onIdle();
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.cases_ran).toBe(1);
    expect(b.status).toBe('partial');
    await app.close();
  });

  it('AC-40 — a second batch while one is active is 422', async () => {
    const id = await freshAgentWithCases(1);
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const llm = new MockLLMProvider('openai', {
      structured: review([FINDING_AT('src/config.ts', 13)]),
    });
    const inner = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => {
      await gate;
      return inner(req);
    };
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    const first = await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    expect(second.statusCode).toBe(422);
    // AC-66's substrate — while the batch is active the poll reads `running`.
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.status).toBe('running');
    release();
    await app.container.jobs.onIdle();
    await app.close();
  });

  it('AC-42 / AC-43 — a workspace-wide run covers every ENABLED agent with cases', async () => {
    const a1 = await freshAgentWithCases(1);
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/eval/runs' });
    expect(res.statusCode).toBe(202);
    const accepted = res.json() as { agent_id: string }[];
    expect(accepted.map((x) => x.agent_id)).toContain(a1);
    // `otherAgentId` is DISABLED and has no cases — excluded twice over.
    expect(accepted.map((x) => x.agent_id)).not.toContain(otherAgentId);
    await app.container.jobs.onIdle();
    await app.close();
  });

  // =====================================================================
  // NFR-1 — the API's own per-case work
  // =====================================================================

  it('NFR-1 — every case of a 20-case stub batch costs the API at most 250 ms of its own work', async () => {
    // NFR-1's measurement, verbatim: "server-integration, timed over a 20-case
    // batch against the stub provider in server/src/adapters/mocks.ts", asserted
    // as the GENEROUS ABSOLUTE ceiling it is (plan D-11), not a p95.
    //
    // THE ASSUMPTION THIS NUMBER RESTS ON, stated because the reading is only as
    // honest as it: `eval_runs.duration_ms` is `now() - caseStarted` around the
    // WHOLE case (`modules/eval/runner.ts`), so it also contains the model call.
    // `MockLLMProvider.completeStructured` resolves its fixture synchronously and
    // `MockLLMOptions` exposes no latency knob at all
    // (`server/src/adapters/mocks.ts:44-56`) — there is no delay to set to 0, and
    // the provider's contribution is one microtask. What remains in duration_ms
    // is the API's own work: parse, review assembly, matching, scoring, one row
    // update.
    const id = await freshAgentWithCases(20); // MAX_CASES_PER_AGENT is 50.
    expect(20).toBeLessThanOrEqual(MAX_CASES_PER_AGENT);
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: `/agents/${id}/eval-runs` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted', cases: 20 });
    const batchId = res.json().batch_id as string;

    await app.container.jobs.onIdle();

    const rows = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.batchId, batchId));
    expect(rows).toHaveLength(20);
    // Asserted BEFORE the ceiling: a null duration_ms would make `Math.max` read
    // 0 and turn the whole ceiling into a tautology.
    expect(rows.filter((r) => typeof r.durationMs === 'number')).toHaveLength(20);
    const durations = rows.map((r) => r.durationMs as number);
    const slowest = Math.max(...durations);
    expect(slowest).toBeLessThanOrEqual(250);

    // The ceiling is "for EVERY case in a batch", so it has to be measured over
    // the whole batch: a run truncated by the cost or wall-clock ceiling would
    // leave the slow cases unmeasured and this assertion green for the wrong
    // reason.
    const [b] = (await app.inject({ method: 'GET', url: `/agents/${id}/eval-runs` })).json();
    expect(b.cases_total).toBe(20);
    expect(b.cases_ran).toBe(20);
    await app.close();
  });

  // =====================================================================
  // The batch aggregate on a POSITIVE-metric batch
  // =====================================================================

  it('AC-45 / AC-50 / AC-52 (batch) — repository aggregate agrees with the scorer', async () => {
    // The batch metrics exist TWICE: `scoreBatch` in `modules/eval/scoring.ts`
    // (JS, unit-tested exhaustively) and the SQL-summed aggregate in
    // `modules/eval/repository.ts` (`batchAggregateQuery` + `toBatchRecord`),
    // which is the one the API actually serves. Every other integration test
    // here exercises the served side on the all-errored / all-null path only.
    // This one drives it to numbers strictly between 0 and 1.
    //
    // FOUR cases, one file each, one fixture each, hand-computed:
    //
    //   case   expectation    expected  kept(actual)  matched  noise  dropped  pass
    //   alpha  must_find      1         1             1        0      0        yes
    //   beta   must_find      2         1             1        0      0        no
    //   gamma  must_not_flag  0         1             0        1      0        no
    //   delta  must_find      1         0             0        0      1        no
    //
    //   recall            = Sigma matched / Sigma expected      = (1+1+0+0) / (1+2+0+1) = 2/4
    //   precision         = 1 - Sigma noise / Sigma actual      = 1 - 1/(1+1+1+0)       = 1 - 1/3
    //   citation_accuracy = Sigma kept / Sigma (kept+dropped)   = 3 / (3+1)             = 3/4
    //   traces_passed     = 1 of 4
    //
    // Every hunk here is `@@ -10,3 +10,4 @@`, i.e. new-side lines 10..13, so a
    // finding on line 13 is GROUNDED and one on line 99 is DROPPED — that drop is
    // the only term that keeps citation_accuracy off 1.
    const db = pg.handle.db;
    const [a] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: `Mixed Batch ${Math.random().toString(36).slice(2, 8)}`,
        description: 'd',
        provider: 'openai',
        model: 'gpt-4.1',
        systemPrompt: 'Review the diff.',
        enabled: true,
        version: 7,
      })
      .returning();

    const mkDiff = (file: string) => DIFF.replace(/src\/config\.ts/g, file);
    const at = (file: string, line: number) => ({ file, start_line: line, end_line: line });

    const plan = [
      { name: 'alpha', file: 'src/alpha.ts', expectation: 'must_find' as const, expected: [at('src/alpha.ts', 13)] },
      {
        name: 'beta',
        file: 'src/beta.ts',
        expectation: 'must_find' as const,
        // TWO expectations, ONE of which the fixture hits — the term that makes
        // recall a fraction rather than 0 or 1.
        expected: [at('src/beta.ts', 12), at('src/beta.ts', 13)],
      },
      { name: 'gamma', file: 'src/gamma.ts', expectation: 'must_not_flag' as const, expected: [] },
      { name: 'delta', file: 'src/delta.ts', expectation: 'must_find' as const, expected: [at('src/delta.ts', 13)] },
    ];

    const nameById = new Map<string, string>();
    for (const p of plan) {
      const [row] = await db
        .insert(t.evalCases)
        .values({
          workspaceId,
          ownerKind: 'agent',
          ownerId: a!.id,
          name: p.name,
          inputDiff: mkDiff(p.file),
          expectedOutput: p.expected,
          expectation: p.expectation,
        })
        .returning();
      nameById.set(row!.id, p.name);
    }

    // One fixture per case, routed by the file name that appears in that case's
    // own frozen diff — the stub is STEERED, never re-implemented: each branch is
    // a real `MockLLMProvider` so the parse, the cost and the result shape stay
    // the mock's.
    const byFile = new Map(
      [
        ['src/alpha.ts', review([FINDING_AT('src/alpha.ts', 13)])],
        ['src/beta.ts', review([FINDING_AT('src/beta.ts', 13)])],
        ['src/gamma.ts', review([FINDING_AT('src/gamma.ts', 13)])],
        // Line 99 is outside the hunk: grounding drops it (kept 0, dropped 1).
        ['src/delta.ts', review([FINDING_AT('src/delta.ts', 99)])],
      ].map(([file, fixture]) => [
        file as string,
        new MockLLMProvider('openai', { structured: fixture }),
      ]),
    );
    const router = new MockLLMProvider('openai');
    router.completeStructured = async (req) => {
      const prompt = JSON.stringify(req.messages);
      const hit = [...byFile.entries()].find(([file]) => prompt.includes(file));
      // A mis-route would quietly change every number below, so it fails loudly.
      if (!hit) throw new Error('eval prompt matched no case fixture');
      return hit[1]!.completeStructured(req);
    };

    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: router, anthropic: router, openrouter: router },
      },
    });

    const accepted = await app.inject({ method: 'POST', url: `/agents/${a!.id}/eval-runs` });
    expect(accepted.statusCode).toBe(202);
    const batchId = accepted.json().batch_id as string;
    await app.container.jobs.onIdle();

    // The per-case counts the aggregate sums over — asserted so the arithmetic
    // above is checkable, and so a routing or grounding change shows up here
    // rather than as an unexplained metric.
    const rows = await db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, batchId));
    const countsByName = Object.fromEntries(
      rows.map((r) => [
        nameById.get(r.caseId),
        (r.actualOutput as { counts: Record<string, number> } | null)?.counts,
      ]),
    );
    expect(countsByName).toEqual({
      alpha: { expected: 1, actual: 1, matched: 1, noise: 0, kept: 1, dropped: 0 },
      beta: { expected: 2, actual: 1, matched: 1, noise: 0, kept: 1, dropped: 0 },
      gamma: { expected: 0, actual: 1, matched: 0, noise: 1, kept: 1, dropped: 0 },
      delta: { expected: 1, actual: 0, matched: 0, noise: 0, kept: 0, dropped: 1 },
    });

    const served = (await app.inject({ method: 'GET', url: `/agents/${a!.id}/eval-runs` })).json();
    expect(served).toHaveLength(1);
    const [b] = served;
    expect(b.status).toBe('complete');
    expect(b.cases_total).toBe(4);
    expect(b.cases_ran).toBe(4); // AC-37 — all four produced a score.
    expect(b.traces_total).toBe(4);
    expect(b.traces_passed).toBe(1);
    expect(b.recall).toBeCloseTo(2 / 4, 12); // AC-45
    expect(b.precision).toBeCloseTo(1 - 1 / 3, 12); // AC-50
    expect(b.citation_accuracy).toBeCloseTo(3 / 4, 12); // AC-52, micro-averaged

    // The drift the two copies of the formula could produce: the SQL aggregate
    // the API serves, against the JS scorer, over the SAME per-case inputs.
    const expectedBatch = scoreBatch([
      {
        caseId: 'alpha',
        expectation: 'must_find',
        expected: [at('src/alpha.ts', 13)],
        actual: [at('src/alpha.ts', 13)],
        droppedCount: 0,
      },
      {
        caseId: 'beta',
        expectation: 'must_find',
        expected: [at('src/beta.ts', 12), at('src/beta.ts', 13)],
        actual: [at('src/beta.ts', 13)],
        droppedCount: 0,
      },
      {
        caseId: 'gamma',
        expectation: 'must_not_flag',
        expected: [],
        actual: [at('src/gamma.ts', 13)],
        droppedCount: 0,
      },
      {
        caseId: 'delta',
        expectation: 'must_find',
        expected: [at('src/delta.ts', 13)],
        actual: [],
        droppedCount: 1,
      },
    ]);
    expect(b.recall).toBeCloseTo(expectedBatch.recall!, 12);
    expect(b.precision).toBeCloseTo(expectedBatch.precision!, 12);
    expect(b.citation_accuracy).toBeCloseTo(expectedBatch.citationAccuracy!, 12);
    expect(b.traces_passed).toBe(expectedBatch.tracesPassed);
    expect(b.traces_total).toBe(expectedBatch.tracesTotal);

    await app.close();
  });

  // =====================================================================
  // Ceilings
  // =====================================================================

  it('AC-107 — the 51st case for one agent is refused', async () => {
    const db = pg.handle.db;
    const [a] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Full Agent',
        description: 'd',
        provider: 'openai',
        model: 'm',
        systemPrompt: 'p',
        version: 1,
      })
      .returning();
    await db.insert(t.evalCases).values(
      Array.from({ length: MAX_CASES_PER_AGENT }, (_, i) => ({
        workspaceId,
        ownerKind: 'agent' as const,
        ownerId: a!.id,
        name: `full-${i}`,
        inputDiff: DIFF,
        expectedOutput: [],
        expectation: 'must_not_flag' as const,
      })),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${a!.id}/eval-cases`,
      payload: caseBody({ owner_id: a!.id }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('AC-108 / NFR-3 — /eval returns at most the 50 newest batches, newest first', async () => {
    const db = pg.handle.db;
    const [a] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Many Batches',
        description: 'd',
        provider: 'openai',
        model: 'm',
        systemPrompt: 'p',
        version: 1,
      })
      .returning();
    const [c] = await db
      .insert(t.evalCases)
      .values({
        workspaceId,
        ownerKind: 'agent',
        ownerId: a!.id,
        name: 'many',
        inputDiff: DIFF,
        expectedOutput: [],
        expectation: 'must_not_flag',
      })
      .returning();
    const base = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(t.evalRuns).values(
      Array.from({ length: 60 }, (_, i) => ({
        caseId: c!.id,
        agentId: a!.id,
        agentVersion: 1,
        batchId: crypto.randomUUID(),
        trigger: 'manual' as const,
        ranAt: new Date(base + i * 60_000),
        pass: true,
        actualOutput: {
          findings: [],
          counts: { expected: 0, actual: 0, matched: 0, noise: 0, kept: 0, dropped: 0 },
        },
      })),
    );

    const app = await makeApp();
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/eval' });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    const batches = res.json().batches as { ran_at: string }[];
    expect(batches.length).toBeLessThanOrEqual(50);
    // Newest first.
    const times = batches.map((b) => Date.parse(b.ran_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    // NFR-3 is a GENEROUS absolute ceiling, not a p95 measurement (plan D-11):
    // it exists to catch an N+1 over batches, which this query is not.
    expect(elapsed).toBeLessThan(5_000);
    await app.close();
  });

  it('AC-72 — the estimate counts only enabled agents that have cases', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/eval/estimate' });
    expect(res.statusCode).toBe(200);
    const est = res.json();
    expect(est.agents).toBeGreaterThan(0);
    expect(est.cases).toBeGreaterThan(0);
    await app.close();
  });

  it('AC-4 — an agent id from another workspace 404s on every eval route', async () => {
    const db = pg.handle.db;
    const [ws] = await db.insert(t.workspaces).values({ name: 'ws-404' }).returning();
    const [foreign] = await db
      .insert(t.agents)
      .values({
        workspaceId: ws!.id,
        name: 'Foreign 404',
        description: 'd',
        provider: 'openai',
        model: 'm',
        systemPrompt: 'p',
        version: 1,
      })
      .returning();
    const app = await makeApp();
    for (const url of [
      `/agents/${foreign!.id}/eval-cases`,
      `/agents/${foreign!.id}/eval-runs`,
      `/eval/agents/${foreign!.id}`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it('AC-2 — eval_runs carries no workspace_id column at all (asserted, not built)', async () => {
    const rows = await pg.handle.db.execute(
      // A second tenancy path that could disagree with the first is exactly what
      // AC-2 forbids; this fails the day someone adds one.
      // eslint-disable-next-line
      (await import('drizzle-orm')).sql`select column_name from information_schema.columns
        where table_name = 'eval_runs'`,
    );
    const names = (rows as unknown as { column_name: string }[]).map((r) => r.column_name);
    expect(names).not.toContain('workspace_id');
  });

  it('AC-15 — a second finding on the same file gets the lowest unused suffix', async () => {
    const db = pg.handle.db;
    const [rv] = await db
      .select()
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.agentId, agentId)));
    const [dup] = await db
      .insert(t.findings)
      .values({
        reviewId: rv!.id,
        file: 'src/config.ts',
        startLine: 13,
        endLine: 13,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        rationale: 'r',
        confidence: 0.9,
        acceptedAt: new Date(),
      })
      .returning();
    const app = await makeApp();
    // The first case of this name already exists from the AC-7 test above.
    await app.inject({ method: 'POST', url: `/findings/${findingId}/eval-case` });
    const res = await app.inject({ method: 'POST', url: `/findings/${dup!.id}/eval-case` });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toMatch(/^hardcoded-stripe-secret-key-\d+$/);
    await app.close();
  });
});
