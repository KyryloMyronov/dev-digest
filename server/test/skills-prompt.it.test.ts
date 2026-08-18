import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns, waitForTrace } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { Review } from '@devdigest/shared';
import { intentLlm } from './helpers/intent.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-prompt] Docker not available — skipping integration tests.');
}

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const REVIEW_FIXTURE: Review = {
  verdict: 'comment',
  summary: 'Nothing blocking.',
  score: 90,
  findings: [],
};

/**
 * Skills → prompt, over a real run.
 *
 * This is the acceptance criterion the whole feature rests on, and it is the one
 * link nothing else covers: the library and the link table can be perfect while
 * `run-executor` never passes the bodies to `assemblePrompt`, and every screen
 * would still look right. The evidence is the persisted trace's
 * `prompt_assembly.skills` plus the run log, i.e. exactly what the Run Trace
 * drawer shows the user.
 *
 * The LLM is a mock, so this asserts what was SENT, not what a model concluded —
 * the with/without-skills quality comparison is a manual experiment, not a test.
 */
d('skills reach the assembled prompt', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoSeq = 0;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: {
          openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
          // L03 — the intent derivation runs on its own (openrouter) feature
          // model before the review. See test/helpers/intent.ts.
          openrouter: intentLlm(),
        },
      },
    });
  }

  async function setupPr() {
    const { db } = pg.handle;
    const name = `skills-repo-${repoSeq++}`;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 501,
        title: 'Add a happy-path test only',
        author: 'tomek.w',
        branch: 'feat/tests',
        base: 'main',
        headSha: 'deadbeef',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    return pr!;
  }

  type App = Awaited<ReturnType<typeof makeApp>>;

  async function makeAgent(app: App, name: string) {
    return (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: {
          name,
          provider: 'openai' as const,
          model: 'gpt-4.1',
          system_prompt: 'You review tests.',
          // Off so the prompt contains nothing but the task, the diff and the
          // skills block — the assertions below are then unambiguous.
          repo_intel: false,
        },
      })
    ).json().id as string;
  }

  async function makeSkill(app: App, payload: Record<string, unknown>) {
    return (await app.inject({ method: 'POST', url: '/skills', payload })).json().id as string;
  }

  /** Run one agent on one PR and return its persisted trace. */
  async function runAndGetTrace(app: App, prId: string, agentId: string, expected: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/review`,
      payload: { agentId },
    });
    expect(res.statusCode).toBe(200);
    const runId = res.json().runs[0].run_id as string;
    await waitForPrRuns(pg.handle.db, prId, { expected });
    // The trace is written AFTER the run goes terminal, so waiting on run status
    // alone races the read — see waitForTrace.
    await waitForTrace(pg.handle.db, runId);
    return (await app.inject({ method: 'GET', url: `/runs/${runId}/trace` })).json();
  }

  it('an enabled skill appears as its own labelled block; the log names it', async () => {
    const app = await makeApp();
    const pr = await setupPr();
    const agentId = await makeAgent(app, 'Skilled Reviewer');
    const skillId = await makeSkill(app, {
      name: 'uncovered-branches',
      description: 'Apply when the diff adds a conditional.',
      type: 'rubric',
      body: '# Uncovered branches\n\nEnumerate the outcomes.',
    });
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: skillId }] },
    });

    const trace = await runAndGetTrace(app, pr.id, agentId, 1);

    expect(trace.prompt_assembly.skills).toContain('### Skill: uncovered-branches (rubric · v1)');
    expect(trace.prompt_assembly.skills).toContain('Enumerate the outcomes.');
    // The block is rendered under its own heading in the user message.
    expect(trace.prompt_assembly.user).toContain('## Skills / rules');
    // A skill is instructions, not quarantined data — see _shared/skills.ts.
    expect(trace.prompt_assembly.skills).not.toContain('<untrusted');

    const log = (trace.log as { msg: string }[]).map((l) => l.msg).join('\n');
    expect(log).toContain('Skills attached (1): uncovered-branches');

    await app.close();
  });

  it('a link disabled for the agent produces NO skills block at all', async () => {
    const app = await makeApp();
    const pr = await setupPr();
    const agentId = await makeAgent(app, 'Unskilled Reviewer');
    const skillId = await makeSkill(app, {
      name: 'corner-cases',
      description: 'Apply when the diff tests a collection.',
      type: 'rubric',
      body: '# Corner cases\n\nVisit the edges.',
    });
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: skillId, enabled: false }] },
    });

    const trace = await runAndGetTrace(app, pr.id, agentId, 1);

    // `null`, not an empty string: the section is omitted entirely, so the
    // prompt is byte-identical to the no-skills baseline.
    expect(trace.prompt_assembly.skills).toBeNull();
    expect(trace.prompt_assembly.user).not.toContain('## Skills / rules');
    expect(trace.prompt_assembly.user).not.toContain('Visit the edges.');

    // …but the skill is still attached, and the log says why it was left out.
    const links = (await app.inject({ method: 'GET', url: `/agents/${agentId}/skills` })).json();
    expect(links).toHaveLength(1);
    const log = (trace.log as { msg: string }[]).map((l) => l.msg).join('\n');
    expect(log).toContain('Skills disabled, not in prompt: corner-cases');

    await app.close();
  });

  it('a skill switched off in the library is skipped even when the link is enabled', async () => {
    const app = await makeApp();
    const pr = await setupPr();
    const agentId = await makeAgent(app, 'Globally Off Reviewer');
    const skillId = await makeSkill(app, {
      name: 'mocking-discipline',
      description: 'Apply when a test mocks a collaborator.',
      type: 'convention',
      body: '# Mocking discipline\n\nDo not mock the subject.',
      enabled: false,
    });
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: skillId, enabled: true }] },
    });

    const trace = await runAndGetTrace(app, pr.id, agentId, 1);

    expect(trace.prompt_assembly.skills).toBeNull();
    await app.close();
  });

  it('blocks are concatenated in link order, and reordering changes the prompt', async () => {
    const app = await makeApp();
    const agentId = await makeAgent(app, 'Ordered Reviewer');
    const first = await makeSkill(app, {
      name: 'aaa-first',
      description: 'First.',
      type: 'rubric',
      body: 'Body of first.',
    });
    const second = await makeSkill(app, {
      name: 'zzz-second',
      description: 'Second.',
      type: 'rubric',
      body: 'Body of second.',
    });

    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: first }, { skill_id: second }] },
    });
    const pr1 = await setupPr();
    const before = await runAndGetTrace(app, pr1.id, agentId, 1);
    expect(before.prompt_assembly.skills.indexOf('aaa-first')).toBeLessThan(
      before.prompt_assembly.skills.indexOf('zzz-second'),
    );

    // Swap them — the order in agent_skills, not the skills' names, decides.
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: second }, { skill_id: first }] },
    });
    const pr2 = await setupPr();
    const after = await runAndGetTrace(app, pr2.id, agentId, 1);
    expect(after.prompt_assembly.skills.indexOf('zzz-second')).toBeLessThan(
      after.prompt_assembly.skills.indexOf('aaa-first'),
    );

    await app.close();
  });

  it('an imported skill is labelled `source: imported` in the prompt', async () => {
    const app = await makeApp();
    const pr = await setupPr();
    const agentId = await makeAgent(app, 'Import Consumer');
    const skillId = await makeSkill(app, {
      name: 'test-flake-signals',
      description: 'Apply when the diff adds a test.',
      type: 'convention',
      source: 'imported_url',
      body: '# Flake signals\n\nNo real sleeps.',
    });
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: skillId }] },
    });

    const trace = await runAndGetTrace(app, pr.id, agentId, 1);

    // The marker is the whole mitigation for a foreign skill being treated as
    // instructions — if this heading loses it, the trace stops distinguishing
    // someone else's rules from the workspace's own.
    expect(trace.prompt_assembly.skills).toContain(
      '### Skill: test-flake-signals (convention · v1 · source: imported)',
    );
    await app.close();
  });

  it('an agent with no skills gets no skills section (the baseline)', async () => {
    const app = await makeApp();
    const pr = await setupPr();
    const agentId = await makeAgent(app, 'Bare Reviewer');

    const trace = await runAndGetTrace(app, pr.id, agentId, 1);

    expect(trace.prompt_assembly.skills).toBeNull();
    expect(trace.prompt_assembly.user).not.toContain('## Skills / rules');
    await app.close();
  });
});
