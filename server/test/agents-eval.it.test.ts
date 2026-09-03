import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { AGENT_VERSION_EVAL_JOB_KIND } from '../src/modules/eval/constants.js';
import type { EvalTrigger, EvalTriggerField } from '../src/modules/eval/types.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[agents-eval] Docker not available — skipping integration tests.');
}

/**
 * SPEC-04 step 20 — phase-2 server integration: AC-80-AC-92, AC-103-AC-105,
 * NFR-17.
 *
 * The assertions are on the `eval_runs` and `agent_versions` ROWS, not on the
 * `jobs` row: plan D-1 accepts that a batch's `jobs` row may read `failed` while
 * the batch itself completed, so the jobs table is the one place that is allowed
 * to disagree with what happened.
 */

const DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  ' const b = 2;',
  '+const key = 3;',
  ' const c = 3;',
].join('\n');

d('SPEC-04 phase 2 — version bumps, auto-eval and restore', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let skillId: string;

  beforeAll(async () => {
    pg = await startPg();
    const s = await seed(pg.handle.db);
    workspaceId = s.workspaceId;
    const [skill] = await pg.handle.db
      .insert(t.skills)
      .values({
        workspaceId,
        name: 'Bump Skill',
        description: 'd',
        type: 'guideline',
        source: 'local',
        body: 'Be careful.',
        enabled: true,
        version: 1,
      })
      .returning();
    skillId = skill!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  /** A recording trigger — AC-91's "no handler registered" is its default. */
  class RecordingTrigger implements EvalTrigger {
    calls: { agentId: string; version: number; changed: readonly EvalTriggerField[] }[] = [];
    async onAgentVersionBumped(
      _w: string,
      agentId: string,
      version: number,
      changed: readonly EvalTriggerField[],
    ): Promise<void> {
      this.calls.push({ agentId, version, changed });
    }
  }

  function makeApp(trigger?: EvalTrigger) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const llm = new MockLLMProvider('openai', {
      structured: { verdict: 'approve', summary: 's', score: 95, findings: [] },
    });
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
        ...(trigger ? { evalTrigger: trigger } : {}),
      },
    });
  }

  async function newAgent(app: Awaited<ReturnType<typeof buildApp>>, over: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: `Bump ${Math.random().toString(36).slice(2, 8)}`,
        provider: 'openai',
        model: 'gpt-4.1',
        system_prompt: 'Review the diff.',
        ...over,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; version: number; auto_eval: boolean };
  }

  // =====================================================================
  // AC-80 … AC-84 — skill-link changes bump and snapshot
  // =====================================================================

  it('AC-80 / AC-84 — linking a skill bumps the version and snapshots the new link set', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    expect(a.version).toBe(1);

    const linked = await app.inject({
      method: 'POST',
      url: `/agents/${a.id}/skills`,
      payload: { skill_id: skillId },
    });
    expect(linked.statusCode).toBe(200);

    const after = (await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json();
    expect(after.version).toBe(2);

    const versions = (
      await app.inject({ method: 'GET', url: `/agents/${a.id}/versions` })
    ).json() as { version: number; config: { skills: string[] } }[];
    expect(versions[0]!.version).toBe(2);
    // AC-84's substance: the snapshot records the link set AS IT NOW IS, which
    // only holds because the bump runs after the link mutation.
    expect(versions[0]!.config.skills).toEqual([skillId]);
    await app.close();
  });

  it('AC-82 — toggling a link’s per-agent switch bumps the version', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    await app.inject({ method: 'POST', url: `/agents/${a.id}/skills`, payload: { skill_id: skillId } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${a.id}/skills/${skillId}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json().version).toBe(3);
    await app.close();
  });

  it('AC-81 — unlinking bumps the version and the snapshot loses the skill', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    await app.inject({ method: 'POST', url: `/agents/${a.id}/skills`, payload: { skill_id: skillId } });
    await app.inject({ method: 'DELETE', url: `/agents/${a.id}/skills/${skillId}` });
    const versions = (
      await app.inject({ method: 'GET', url: `/agents/${a.id}/versions` })
    ).json() as { version: number; config: { skills: string[] } }[];
    expect(versions[0]!.version).toBe(3);
    expect(versions[0]!.config.skills).toEqual([]);
    await app.close();
  });

  it('AC-83 — replacing the whole link set bumps the version', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${a.id}/skills`,
      payload: { links: [{ skill_id: skillId, enabled: true }] },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json().version).toBe(2);
    await app.close();
  });

  // =====================================================================
  // AC-85 — the allow-list, over the real write path
  // =====================================================================

  it('AC-85 — a prompt edit notifies the trigger; a ci_fail_on edit does not', async () => {
    const trigger = new RecordingTrigger();
    const app = await makeApp(trigger);
    const a = await newAgent(app);

    await app.inject({
      method: 'PUT',
      url: `/agents/${a.id}`,
      payload: { system_prompt: 'A different prompt.' },
    });
    expect(trigger.calls.filter((c) => c.agentId === a.id)).toHaveLength(1);
    expect(trigger.calls.at(-1)!.changed).toEqual(['system_prompt']);

    // `ci_fail_on` still BUMPS the version (AC-84) and still snapshots — it just
    // notifies nothing (plan D-13).
    const before = (await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json().version;
    await app.inject({ method: 'PUT', url: `/agents/${a.id}`, payload: { ci_fail_on: 'any' } });
    const after = (await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json();
    expect(after.version).toBe(before + 1);
    expect(trigger.calls.filter((c) => c.agentId === a.id)).toHaveLength(1);
    await app.close();
  });

  it('AC-85 — `auto_eval` round-trips through POST and PUT and is not itself a trigger', async () => {
    const trigger = new RecordingTrigger();
    const app = await makeApp(trigger);
    const a = await newAgent(app, { auto_eval: true });
    expect(a.auto_eval).toBe(true);

    // A PUT that omits it must not clear it.
    await app.inject({ method: 'PUT', url: `/agents/${a.id}`, payload: { name: 'Renamed' } });
    expect((await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json().auto_eval).toBe(true);

    // Turning it off is not itself an allow-listed change.
    const callsBefore = trigger.calls.length;
    await app.inject({ method: 'PUT', url: `/agents/${a.id}`, payload: { auto_eval: false } });
    expect((await app.inject({ method: 'GET', url: `/agents/${a.id}` })).json().auto_eval).toBe(false);
    expect(trigger.calls).toHaveLength(callsBefore);
    await app.close();
  });

  // =====================================================================
  // AC-87 / NFR-17 — the debounce, over the real queue
  // =====================================================================

  /** Jobs of this kind whose payload names one agent — the workspace is shared. */
  async function jobsFor(agentId: string) {
    const rows = await pg.handle.db
      .select()
      .from(t.jobs)
      .where(and(eq(t.jobs.workspaceId, workspaceId), eq(t.jobs.kind, AGENT_VERSION_EVAL_JOB_KIND)));
    return rows.filter((r) => (r.payload as { agentId?: string } | null)?.agentId === agentId);
  }

  /**
   * Hold every job in the QUEUE, unstarted.
   *
   * AC-87's marker is cleared when the job FINISHES, and an
   * `agent-version-eval` job that starts between two edits legitimately clears
   * it — AC-88 then skips the now-stale payload and the next edit queues
   * afresh. That is correct behaviour and it is also a race: with a mock
   * provider the handler can finish in under a millisecond. Pausing p-queue
   * pins the state the criterion is actually about — a job that is PENDING —
   * instead of racing the scheduler for it.
   */
  function pauseJobs(app: Awaited<ReturnType<typeof buildApp>>) {
    const q = (app.container.jobs as unknown as { queue: { pause(): void; start(): void } }).queue;
    q.pause();
    return () => q.start();
  }

  async function agentWithAutoEvalCase(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
    const a = await newAgent(app, { auto_eval: true });
    await pg.handle.db.insert(t.evalCases).values({
      workspaceId,
      ownerKind: 'agent',
      ownerId: a.id,
      name,
      inputDiff: DIFF,
      inputMeta: { task: 'Review' },
      expectedOutput: [],
      expectation: 'must_not_flag',
    });
    return a;
  }

  it('NFR-17 / AC-87 — five rapid prompt edits queue at most ONE pending job', async () => {
    const app = await makeApp();
    const a = await agentWithAutoEvalCase(app, 'auto-case');
    const release = pauseJobs(app);

    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'PUT',
        url: `/agents/${a.id}`,
        payload: { system_prompt: `Prompt revision ${i}.` },
      });
    }
    expect(await jobsFor(a.id)).toHaveLength(1);

    release();
    await app.container.jobs.onIdle();
    await app.close();
  });

  it('mutation check for NFR-17 — with the pending marker cleared, five edits queue five', async () => {
    const app = await makeApp();
    const a = await agentWithAutoEvalCase(app, 'auto-case-2');
    const release = pauseJobs(app);
    const trigger = app.container.evalTrigger as unknown as { pending: Set<string> };

    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'PUT',
        url: `/agents/${a.id}`,
        payload: { system_prompt: `Revision ${i}.` },
      });
      // The marker IS the mechanism; clearing it must move the count, or the
      // assertion above pins nothing (root insights.md 2026-08-29).
      trigger.pending.clear();
    }
    expect(await jobsFor(a.id)).toHaveLength(5);

    release();
    await app.container.jobs.onIdle();
    await app.close();
  });

  // =====================================================================
  // AC-88 / AC-89 / AC-90 — the handler
  // =====================================================================

  it('AC-90 — an auto-eval batch stamps `version-change` on every eval_runs row', async () => {
    const app = await makeApp();
    const a = await newAgent(app, { auto_eval: true });
    await pg.handle.db.insert(t.evalCases).values([
      {
        workspaceId,
        ownerKind: 'agent',
        ownerId: a.id,
        name: 'vc-1',
        inputDiff: DIFF,
        inputMeta: { task: 'Review' },
        expectedOutput: [],
        expectation: 'must_not_flag',
      },
      {
        workspaceId,
        ownerKind: 'agent',
        ownerId: a.id,
        name: 'vc-2',
        inputDiff: DIFF,
        inputMeta: { task: 'Review' },
        expectedOutput: [],
        expectation: 'must_not_flag',
      },
    ]);

    await app.inject({
      method: 'PUT',
      url: `/agents/${a.id}`,
      payload: { system_prompt: 'Auto-eval me.' },
    });
    await app.container.jobs.onIdle();

    const runs = await pg.handle.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.agentId, a.id));
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.trigger === 'version-change')).toBe(true);
    expect(new Set(runs.map((r) => r.batchId)).size).toBe(1);
    await app.close();
  });

  it('AC-89 — the same auto-eval payload delivered twice starts no second batch', async () => {
    const app = await makeApp();
    const a = await newAgent(app, { auto_eval: true });
    await pg.handle.db.insert(t.evalCases).values({
      workspaceId,
      ownerKind: 'agent',
      ownerId: a.id,
      name: 'dupe-1',
      inputDiff: DIFF,
      inputMeta: { task: 'Review' },
      expectedOutput: [],
      expectation: 'must_not_flag',
    });
    await app.inject({
      method: 'PUT',
      url: `/agents/${a.id}`,
      payload: { system_prompt: 'Once.' },
    });
    await app.container.jobs.onIdle();
    const first = await pg.handle.db.select().from(t.evalRuns).where(eq(t.evalRuns.agentId, a.id));
    const version = first[0]!.agentVersion!;

    // Re-deliver the identical payload straight to the handler.
    await app.container.jobs.enqueue(workspaceId, AGENT_VERSION_EVAL_JOB_KIND, {
      workspaceId,
      agentId: a.id,
      version,
    });
    await app.container.jobs.onIdle();
    const second = await pg.handle.db.select().from(t.evalRuns).where(eq(t.evalRuns.agentId, a.id));
    expect(second.length).toBe(first.length);
    await app.close();
  });

  it('AC-88 — a payload naming a stale version runs nothing', async () => {
    const app = await makeApp();
    const a = await newAgent(app, { auto_eval: true });
    await pg.handle.db.insert(t.evalCases).values({
      workspaceId,
      ownerKind: 'agent',
      ownerId: a.id,
      name: 'stale-1',
      inputDiff: DIFF,
      inputMeta: { task: 'Review' },
      expectedOutput: [],
      expectation: 'must_not_flag',
    });
    await app.container.jobs.enqueue(workspaceId, AGENT_VERSION_EVAL_JOB_KIND, {
      workspaceId,
      agentId: a.id,
      version: 0, // the agent is already on 1
    });
    await app.container.jobs.onIdle();
    const runs = await pg.handle.db.select().from(t.evalRuns).where(eq(t.evalRuns.agentId, a.id));
    expect(runs).toHaveLength(0);
    await app.close();
  });

  // =====================================================================
  // AC-91 — degradation
  // =====================================================================

  it('AC-91 — with no eval handler registered, PUT /agents/:id still returns 200', async () => {
    // An OVERRIDDEN trigger registers nothing, which is exactly the state AC-91
    // describes: `jobs.enqueue` would throw for `agent-version-eval`.
    const app = await makeApp({
      async onAgentVersionBumped(workspaceId, agentId, version) {
        await app.container.jobs.enqueue(workspaceId, AGENT_VERSION_EVAL_JOB_KIND, {
          workspaceId,
          agentId,
          version,
        });
      },
    } as EvalTrigger);
    const a = await newAgent(app, { auto_eval: true });
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${a.id}`,
      payload: { system_prompt: 'Nobody is listening.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(a.id);
    await app.close();
  });

  // =====================================================================
  // AC-103 / AC-104 / AC-105 — restore
  // =====================================================================

  it('AC-103 / AC-104 — a restore writes a NEW version carrying restored_from', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app, { system_prompt: 'Version one prompt.' });
    await app.inject({
      method: 'PUT',
      url: `/agents/${a.id}`,
      payload: { system_prompt: 'Version two prompt.' },
    });

    const res = await app.inject({ method: 'POST', url: `/agents/${a.id}/versions/1/restore` });
    expect(res.statusCode).toBe(200);
    const restored = res.json();
    // A NEW version, never a rewrite of history.
    expect(restored.version).toBe(3);
    expect(restored.system_prompt).toBe('Version one prompt.');

    const versions = (
      await app.inject({ method: 'GET', url: `/agents/${a.id}/versions` })
    ).json() as { version: number; config: { restored_from?: number; system_prompt: string } }[];
    expect(versions[0]!.version).toBe(3);
    expect(versions[0]!.config.restored_from).toBe(1);
    // v1 and v2 are untouched.
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    await app.close();
  });

  it('AC-105 — a restore enqueues NO agent-version-eval job', async () => {
    const trigger = new RecordingTrigger();
    const app = await makeApp(trigger);
    const a = await newAgent(app, { auto_eval: true, system_prompt: 'One.' });
    await app.inject({ method: 'PUT', url: `/agents/${a.id}`, payload: { system_prompt: 'Two.' } });
    const callsBefore = trigger.calls.length;

    const res = await app.inject({ method: 'POST', url: `/agents/${a.id}/versions/1/restore` });
    expect(res.statusCode).toBe(200);
    // The version bumped (AC-103) and nothing was notified (AC-105).
    expect(res.json().version).toBe(3);
    expect(trigger.calls).toHaveLength(callsBefore);
    await app.close();
  });

  it('a restore of a version that was never snapshotted is 404', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    const res = await app.inject({ method: 'POST', url: `/agents/${a.id}/versions/99/restore` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('the restore route takes no body — a body-less POST is not a 422', async () => {
    const app = await makeApp(new RecordingTrigger());
    const a = await newAgent(app);
    const res = await app.inject({ method: 'POST', url: `/agents/${a.id}/versions/1/restore` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
