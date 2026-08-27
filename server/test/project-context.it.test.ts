/**
 * project-context over a real Postgres (SPEC-01).
 *
 * Scoped to what only exists at the DB and HTTP layers: `workspace_id` scoping
 * (AC-3), AC-15's `GROUP BY` against real attachment rows, the token cache
 * (AC-30, AC-34, AC-36), AC-63's 202-before-the-job, and NFR-3's timed read.
 * The walk, the budget, the tokenizer fallback and the traversal guard are all
 * covered hermetically — there is no value in paying for Docker to re-test
 * decisions a stub already pins.
 *
 * The clone is a real temp directory and `DEVDIGEST_CLONE_DIR` points at its
 * parent, so the REAL `SimpleGitClient` (containment guard included) serves the
 * reads rather than a mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { SEED_CONTEXT_PHRASE } from '../src/db/seed-context.js';
import * as t from '../src/db/schema.js';
import { MockGitHubClient } from '../src/adapters/mocks.js';
import { TOKEN_COUNT_JOB_KIND, MAX_CONTEXT_DOCUMENTS } from '../src/modules/project-context/constants.js';
import { ProjectContextService } from '../src/modules/project-context/service.js';
import { ProjectContextRepository } from '../src/modules/project-context/repository.js';
import type { Container } from '../src/platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[project-context] Docker not available — skipping integration tests.');
}

const OWNER = 'acme';
const NAME = 'payments-api';

async function write(root: string, rel: string, contents = 'x'): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

d('project-context module', () => {
  let pg: PgFixture;
  let cloneRoot: string;
  let clonePath: string;
  let workspaceId: string;
  let repoId: string;
  let otherWorkspaceId: string;
  let otherRepoId: string;

  beforeAll(async () => {
    pg = await startPg();
    const seeded = await seed(pg.handle.db);
    workspaceId = seeded.workspaceId;

    // A real clone on disk, under a cloneDir the config will point at.
    cloneRoot = await mkdtemp(join(tmpdir(), 'project-context-it-'));
    clonePath = join(cloneRoot, OWNER, NAME);
    await write(clonePath, 'specs/api.md', '# API spec\n\nAuth is **required**.\n');
    await write(clonePath, 'specs/billing.md', '# Billing\n');
    await write(clonePath, 'docs/specs/nested.md', '# Nested\n');
    await write(clonePath, 'README.md', 'not context');

    const [repo] = await pg.handle.db
      .select()
      .from(t.repos)
      .where(eq(t.repos.fullName, `${OWNER}/${NAME}`));
    repoId = repo!.id;
    await pg.handle.db
      .update(t.repos)
      .set({ clonePath })
      .where(eq(t.repos.id, repoId));

    // A SECOND tenant with its own repo, for the scoping assertions.
    const [ws2] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-tenant' })
      .returning();
    otherWorkspaceId = ws2!.id;
    const [repo2] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId: otherWorkspaceId,
        owner: OWNER,
        name: NAME,
        fullName: `${OWNER}/${NAME}`,
        defaultBranch: 'main',
        clonePath,
      })
      .returning();
    otherRepoId = repo2!.id;
  });

  afterAll(async () => {
    await pg?.stop();
    await rm(cloneRoot, { recursive: true, force: true });
  });

  function makeApp() {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DEVDIGEST_CLONE_DIR: cloneRoot,
    } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      // `git` is deliberately NOT overridden: the real SimpleGitClient resolves
      // `<cloneDir>/<owner>/<name>`, which is exactly `clonePath` above, so the
      // containment guard is in the path this test exercises.
      overrides: { github: new MockGitHubClient() },
    });
  }

  it('lists the repo’s documents with sources, sizes and an honest envelope', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: { path: string; source: string; tokens: number | null; attached_agents: number }[];
      total: number;
      omitted: number;
      scanned_at: string | null;
    };
    expect(body.files.map((f) => f.path)).toEqual([
      'docs/specs/nested.md',
      'specs/api.md',
      'specs/billing.md',
    ]);
    expect(body.files.map((f) => f.source)).toEqual(['docs', 'specs', 'specs']);
    expect(body.total).toBe(3);
    expect(body.omitted).toBe(0);
    await app.close();
  });

  // AC-11 through the real adapter, guard included.
  it('serves one document’s content through the guarded adapter', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/doc?path=specs/api.md`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      path: 'specs/api.md',
      content: '# API spec\n\nAuth is **required**.\n',
    });
    await app.close();
  });

  // AC-62 end to end: a traversal is rejected, not served.
  it('rejects a traversing path on the content route', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/doc?path=${encodeURIComponent('../../../etc/passwd')}`,
    });

    // Caught by the membership check before the adapter — either way the file
    // is not served, which is the property AC-62 asserts.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'doc_not_found' } });
    await app.close();
  });

  it('422s a missing path parameter and a non-uuid repo id', async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: 'GET', url: `/repos/${repoId}/context/doc` })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: 'GET', url: '/repos/not-a-uuid/context' })).statusCode,
    ).toBe(422);
    await app.close();
  });

  // AC-4 at the HTTP layer.
  it('409s repo_not_cloned for a repo with no clone on disk', async () => {
    const app = await makeApp();
    const [bare] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: OWNER,
        name: 'uncloned',
        fullName: `${OWNER}/uncloned`,
        defaultBranch: 'main',
      })
      .returning();

    const res = await app.inject({ method: 'GET', url: `/repos/${bare!.id}/context` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'repo_not_cloned' } });
    await app.close();
  });

  /**
   * AC-3 — the list is scoped to the requesting workspace. The no-auth provider
   * always resolves the default workspace, so the falsifiable half is that a
   * repo id belonging to ANOTHER workspace is not addressable, even though the
   * row exists and its clone is on disk.
   */
  it('does not serve a repo belonging to another workspace (AC-3)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/repos/${otherRepoId}/context` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'repo_not_found' } });
    await app.close();
  });

  /**
   * AC-15 — the count comes from real rows and is scoped by workspace. Two
   * agents in this workspace attach `specs/api.md`; a third row in the other
   * workspace must not be counted.
   */
  it('counts the agents attaching each path, workspace-scoped (AC-15)', async () => {
    const app = await makeApp();
    const [a1] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'ctx-agent-1',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'x',
      })
      .returning();
    const [a2] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'ctx-agent-2',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'x',
      })
      .returning();
    const [a3] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId: otherWorkspaceId,
        name: 'ctx-agent-other',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'x',
      })
      .returning();

    await pg.handle.db.insert(t.agentContextDocs).values([
      { workspaceId, agentId: a1!.id, path: 'specs/api.md', order: 0 },
      { workspaceId, agentId: a2!.id, path: 'specs/api.md', order: 0 },
      { workspaceId, agentId: a2!.id, path: 'specs/billing.md', order: 1 },
      // Same path, different tenant — must not be counted below.
      { workspaceId: otherWorkspaceId, agentId: a3!.id, path: 'specs/api.md', order: 0 },
    ]);

    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    const files = (res.json() as { files: { path: string; attached_agents: number }[] }).files;
    const byPath = new Map(files.map((f) => [f.path, f.attached_agents]));

    expect(byPath.get('specs/api.md')).toBe(2);
    expect(byPath.get('specs/billing.md')).toBe(1);
    expect(byPath.get('docs/specs/nested.md')).toBe(0);

    await pg.handle.db.delete(t.agentContextDocs);
    await pg.handle.db.delete(t.agents).where(eq(t.agents.id, a1!.id));
    await pg.handle.db.delete(t.agents).where(eq(t.agents.id, a2!.id));
    await pg.handle.db.delete(t.agents).where(eq(t.agents.id, a3!.id));
    await app.close();
  });

  /**
   * AC-36 + AC-30 + AC-34 + AC-16 — run the real job against the real clone,
   * then read the list back: every document gains a persisted count, the
   * payload serves it, and `scanned_at` becomes non-null.
   */
  it('persists one token count per document and serves them back (AC-36, AC-30, AC-16)', async () => {
    const app = await makeApp();

    // Before the job: every count is null and there is no scan time (AC-34).
    const before = (await app.inject({ method: 'GET', url: `/repos/${repoId}/context` })).json() as {
      files: { tokens: number | null }[];
      scanned_at: string | null;
    };
    expect(before.files.every((f) => f.tokens === null)).toBe(true);
    expect(before.scanned_at).toBeNull();

    const container = app.container as Container;
    const result = await new ProjectContextService(container).runTokenCountJob({ repoId });
    expect(result.counted).toBe(3);

    const rows = await pg.handle.db
      .select()
      .from(t.contextDocTokens)
      .where(eq(t.contextDocTokens.repoId, repoId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.workspaceId).toBe(workspaceId);
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokens).toBeGreaterThan(0);
    }

    const after = (await app.inject({ method: 'GET', url: `/repos/${repoId}/context` })).json() as {
      files: { path: string; tokens: number | null }[];
      scanned_at: string | null;
    };
    const persisted = new Map(rows.map((r) => [r.path, r.tokens]));
    for (const f of after.files) expect(f.tokens).toBe(persisted.get(f.path));
    expect(after.scanned_at).not.toBeNull();

    // A second pass over an unchanged clone recomputes nothing.
    const again = await new ProjectContextService(container).runTokenCountJob({ repoId });
    expect(again.counted).toBe(0);
    expect(again.unchanged).toBe(3);

    await pg.handle.db.delete(t.contextDocTokens);
    await app.close();
  });

  /**
   * AC-63 — 202 having ENQUEUED the job, without waiting for it. The falsifiable
   * part is that a `jobs` row exists for the kind and that the response came
   * back before the job finished, which a mocked `container.jobs` cannot show.
   */
  it('responds 202 to a reindex with the token-count job enqueued (AC-63)', async () => {
    const app = await makeApp();
    await pg.handle.db.delete(t.jobs);

    const res = await app.inject({ method: 'POST', url: `/repos/${repoId}/context/reindex` });
    expect(res.statusCode).toBe(202);
    // Responded against the existing IndexStatus contract — no fourth type.
    expect(res.json()).toMatchObject({ status: 'parsing', pct: 0 });

    const jobs = await pg.handle.db
      .select()
      .from(t.jobs)
      .where(eq(t.jobs.kind, TOKEN_COUNT_JOB_KIND));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workspaceId).toBe(workspaceId);

    // Let the queue drain so it does not leak into the next test.
    await app.container.jobs.onIdle();
    await pg.handle.db.delete(t.contextDocTokens);
    await pg.handle.db.delete(t.jobs);
    await app.close();
  });

  /**
   * NFR-3 — timed, over a fixture at the cap. Environment-dependent (a
   * containerised Postgres over a socket, plus a 500-file walk of a tmpfs), so
   * the number is PRINTED and the assertion is generous: it exists to catch an
   * N+1 or a per-request tokenizer pass, not to gate on a millisecond figure.
   */
  it('serves a 500-document list well inside the NFR-3 budget (timed)', async () => {
    const bigRoot = await mkdtemp(join(tmpdir(), 'project-context-nfr3-'));
    const bigClone = join(bigRoot, OWNER, 'bulk');
    await Promise.all(
      Array.from({ length: MAX_CONTEXT_DOCUMENTS }, (_, i) =>
        write(bigClone, `specs/doc-${String(i).padStart(4, '0')}.md`, `# doc ${i}\n`),
      ),
    );
    const [bulk] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: OWNER,
        name: 'bulk',
        fullName: `${OWNER}/bulk`,
        defaultBranch: 'main',
        clonePath: bigClone,
      })
      .returning();

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DEVDIGEST_CLONE_DIR: bigRoot,
    } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { github: new MockGitHubClient() },
    });

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const res = await app.inject({ method: 'GET', url: `/repos/${bulk!.id}/context` });
      samples.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
      if (i === 0) {
        expect((res.json() as { files: unknown[] }).files).toHaveLength(MAX_CONTEXT_DOCUMENTS);
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
    // eslint-disable-next-line no-console
    console.log(`[NFR-3] p95 over 20 requests for 500 documents: ${p95.toFixed(0)} ms (budget 800 ms)`);

    expect(p95).toBeLessThan(800);

    await app.close();
    await rm(bigRoot, { recursive: true, force: true });
    await pg.handle.db.delete(t.repos).where(eq(t.repos.id, bulk!.id));
  });

  // ---------------------------------------- attachments (SPEC-01 Cut 2) -----
  //
  // These need real rows: AC-18/19/20 are about what is PERSISTED, AC-21/23 join
  // three tables, and the attach-path validation is falsifiable only by the
  // absence of a row.

  describe('attachments', () => {
    let agentId: string;
    let skillId: string;

    beforeEach(async () => {
      const [agent] = await pg.handle.db
        .insert(t.agents)
        .values({
          workspaceId,
          name: `ctx-attach-agent-${Math.random().toString(36).slice(2, 8)}`,
          provider: 'openai',
          model: 'gpt-4o-mini',
          systemPrompt: 'x',
        })
        .returning();
      agentId = agent!.id;

      const [skill] = await pg.handle.db
        .insert(t.skills)
        .values({
          workspaceId,
          name: 'Security review',
          description: 'd',
          type: 'security',
          source: 'manual',
          body: 'b',
        })
        .returning();
      skillId = skill!.id;
    });

    afterEach(async () => {
      await pg.handle.db.delete(t.agentContextDocs);
      await pg.handle.db.delete(t.skillContextDocs);
      await pg.handle.db.delete(t.agentSkills);
      await pg.handle.db.delete(t.agents).where(eq(t.agents.id, agentId));
      await pg.handle.db.delete(t.skills).where(eq(t.skills.id, skillId));
    });

    // AC-18 — persisted, workspace-scoped, and read back with the discovered
    // document inlined so the tab needs no second request per row.
    it('persists an agent attachment scoped to the workspace and reads it back (AC-18)', async () => {
      const app = await makeApp();

      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });
      expect(res.statusCode).toBe(200);

      const rows = await pg.handle.db
        .select()
        .from(t.agentContextDocs)
        .where(eq(t.agentContextDocs.agentId, agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.workspaceId).toBe(workspaceId);
      expect(rows[0]!.path).toBe('specs/api.md');

      const listed = (
        await app.inject({ method: 'GET', url: `/agents/${agentId}/context-docs?repo_id=${repoId}` })
      ).json() as { path: string; order: number; doc: { source: string; size: number } | null; inherited_from: string | null }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ path: 'specs/api.md', order: 0, inherited_from: null });
      expect(listed[0]!.doc).toMatchObject({ source: 'specs' });

      // Re-attaching the same path is idempotent: still one row.
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });
      expect(
        await pg.handle.db
          .select()
          .from(t.agentContextDocs)
          .where(eq(t.agentContextDocs.agentId, agentId)),
      ).toHaveLength(1);

      await app.close();
    });

    // AC-19 — the full ordered list in one PUT, `order` = index.
    it('persists a new order for an agent’s attachments (AC-19)', async () => {
      const app = await makeApp();
      for (const path of ['specs/api.md', 'specs/billing.md', 'docs/specs/nested.md']) {
        await app.inject({
          method: 'POST',
          url: `/agents/${agentId}/context-docs`,
          payload: { repo_id: repoId, path },
        });
      }

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agentId}/context-docs`,
        payload: {
          repo_id: repoId,
          paths: ['docs/specs/nested.md', 'specs/api.md', 'specs/billing.md'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { path: string }[]).map((r) => r.path)).toEqual([
        'docs/specs/nested.md',
        'specs/api.md',
        'specs/billing.md',
      ]);

      const rows = await pg.handle.db
        .select()
        .from(t.agentContextDocs)
        .where(eq(t.agentContextDocs.agentId, agentId));
      const byPath = new Map(rows.map((r) => [r.path, r.order]));
      expect(byPath.get('docs/specs/nested.md')).toBe(0);
      expect(byPath.get('specs/api.md')).toBe(1);
      expect(byPath.get('specs/billing.md')).toBe(2);

      await app.close();
    });

    it('detaches an agent attachment (AC-18)', async () => {
      const app = await makeApp();
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/agents/${agentId}/context-docs?path=${encodeURIComponent('specs/api.md')}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(
        await pg.handle.db
          .select()
          .from(t.agentContextDocs)
          .where(eq(t.agentContextDocs.agentId, agentId)),
      ).toHaveLength(0);

      await app.close();
    });

    // AC-20 + AC-21 + AC-22 + AC-23 — a skill's documents are inherited AFTER
    // the agent's own, labelled with the skill's name, and a path attached both
    // ways appears once, as the agent's own.
    it('inherits a skill’s documents after the agent’s own, labelled and de-duplicated', async () => {
      const app = await makeApp();

      const attachSkill = await app.inject({
        method: 'POST',
        url: `/skills/${skillId}/context-docs`,
        payload: { repo_id: repoId, path: 'docs/specs/nested.md' },
      });
      expect(attachSkill.statusCode).toBe(200);
      await app.inject({
        method: 'POST',
        url: `/skills/${skillId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });

      const skillRows = await pg.handle.db
        .select()
        .from(t.skillContextDocs)
        .where(eq(t.skillContextDocs.skillId, skillId));
      expect(skillRows).toHaveLength(2);
      expect(skillRows.every((r) => r.workspaceId === workspaceId)).toBe(true);

      // The agent attaches ONE of them directly, and links the skill.
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });
      await pg.handle.db.insert(t.agentSkills).values({ agentId, skillId, order: 0 });

      const listed = (
        await app.inject({ method: 'GET', url: `/agents/${agentId}/context-docs?repo_id=${repoId}` })
      ).json() as { path: string; inherited_from: string | null }[];

      expect(listed.map((r) => r.path)).toEqual(['specs/api.md', 'docs/specs/nested.md']);
      expect(listed[0]!.inherited_from).toBeNull();
      expect(listed[1]!.inherited_from).toBe('Security review');

      // A muted link contributes nothing (both switches gate inheritance).
      await pg.handle.db.delete(t.agentSkills);
      await pg.handle.db.insert(t.agentSkills).values({ agentId, skillId, order: 0, enabled: false });
      const muted = (
        await app.inject({ method: 'GET', url: `/agents/${agentId}/context-docs?repo_id=${repoId}` })
      ).json() as { path: string }[];
      expect(muted.map((r) => r.path)).toEqual(['specs/api.md']);

      await app.close();
    });

    // AC-18 + AC-20's scoping half: the rows exist for THIS workspace and a
    // second `workspace_id` reading the same agent and skill ids sees nothing.
    // Asserted through the repository because the local auth provider resolves
    // one workspace per request, so HTTP cannot express a second tenant.
    it('hides attachments from a second workspace (AC-18, AC-20)', async () => {
      const app = await makeApp();
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });
      await app.inject({
        method: 'POST',
        url: `/skills/${skillId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/billing.md' },
      });

      const repository = new ProjectContextRepository(pg.handle.db);
      expect(await repository.agentDocs(workspaceId, agentId)).toEqual([
        { path: 'specs/api.md', order: 0 },
      ]);
      expect(await repository.agentDocs(otherWorkspaceId, agentId)).toEqual([]);
      expect(await repository.skillDocs(otherWorkspaceId, skillId)).toEqual([]);
      expect(await repository.docsForSkills(otherWorkspaceId, [skillId])).toEqual(new Map());

      await app.close();
    });

    /**
     * THE REVIEW REQUIREMENT (Cut 2, security lane): an attach whose path is not
     * in the repository's discovered document set is REJECTED and persists no
     * row.
     *
     * Why it matters: `SimpleGitClient.readFile`'s containment guard is lexical,
     * so a symlink inside the clone pointing outside it is "contained". Cut 1 was
     * safe because the walk never emits a symlink and `readDoc` reads the walk's
     * own value; Cut 2's resolver reads PERSISTED paths, so this door is the
     * layer that keeps an unknown path out of the table in the first place.
     */
    it('rejects an attach for a path outside the discovered set, persisting no row', async () => {
      const app = await makeApp();

      for (const path of ['README.md', '../../../etc/passwd', 'specs/does-not-exist.md']) {
        const res = await app.inject({
          method: 'POST',
          url: `/agents/${agentId}/context-docs`,
          payload: { repo_id: repoId, path },
        });
        expect(res.statusCode).toBe(404);
        expect((res.json() as { error: { code: string } }).error.code).toBe('doc_not_found');
      }

      const skillRes = await app.inject({
        method: 'POST',
        url: `/skills/${skillId}/context-docs`,
        payload: { repo_id: repoId, path: '../../../etc/passwd' },
      });
      expect(skillRes.statusCode).toBe(404);

      expect(await pg.handle.db.select().from(t.agentContextDocs)).toHaveLength(0);
      expect(await pg.handle.db.select().from(t.skillContextDocs)).toHaveLength(0);

      await app.close();
    });

    /**
     * The reorder endpoint is not a back door around that check — but it must
     * still accept a path that IS attached and is no longer discovered, because
     * AC-29 renders exactly that row and the user has to be able to reorder and
     * remove it.
     */
    it('rejects an undiscovered NEW path on reorder while preserving an unresolved one', async () => {
      const app = await makeApp();
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, path: 'specs/api.md' },
      });
      // A row whose file has since vanished — inserted directly, since the attach
      // route would (correctly) refuse it now.
      await pg.handle.db
        .insert(t.agentContextDocs)
        .values({ workspaceId, agentId, path: 'specs/deleted-since.md', order: 1 });

      const smuggle = await app.inject({
        method: 'PUT',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, paths: ['specs/api.md', 'README.md'] },
      });
      expect(smuggle.statusCode).toBe(404);
      expect(
        (await pg.handle.db.select().from(t.agentContextDocs)).map((r) => r.path).sort(),
      ).toEqual(['specs/api.md', 'specs/deleted-since.md']);

      const reorder = await app.inject({
        method: 'PUT',
        url: `/agents/${agentId}/context-docs`,
        payload: { repo_id: repoId, paths: ['specs/deleted-since.md', 'specs/api.md'] },
      });
      expect(reorder.statusCode).toBe(200);
      const listed = reorder.json() as { path: string; doc: unknown | null }[];
      expect(listed.map((r) => r.path)).toEqual(['specs/deleted-since.md', 'specs/api.md']);
      // AC-29's data half: the unresolved row is present with a null document.
      expect(listed[0]!.doc).toBeNull();
      expect(listed[1]!.doc).not.toBeNull();

      await app.close();
    });

    /**
     * THE SECOND REVIEW REQUIREMENT (Cut 2, security lane, F-12): a write
     * against a parent id that is not the caller's is a 404 and persists no row.
     * All FIVE mutating methods, agent and skill alike.
     *
     * Nothing leaks either way — every read scopes on `workspace_id` AND the
     * parent id, so neither tenant sees the other's row. The consequence is the
     * CASCADE: `agent_context_docs.agent_id` and `skill_context_docs.skill_id`
     * are both `on delete cascade`, so a row written here under `workspaceId`
     * would be silently destroyed when the OTHER workspace deletes its agent or
     * skill.
     *
     * The path is a discovered one, and the expected code is `not_found` rather
     * than `doc_not_found` — together those pin the rejection on the parent
     * check rather than on the membership check next to it. The row counts are
     * asserted for the same reason the step-22 test asserts them: a 404 with a
     * written row would be worse than no check at all.
     */
    it('rejects a write against another workspace’s agent or skill, persisting no row', async () => {
      const app = await makeApp();
      const [foreignAgent] = await pg.handle.db
        .insert(t.agents)
        .values({
          workspaceId: otherWorkspaceId,
          name: `foreign-agent-${Math.random().toString(36).slice(2, 8)}`,
          provider: 'openai',
          model: 'gpt-4o-mini',
          systemPrompt: 'x',
        })
        .returning();
      const foreignAgentId = foreignAgent!.id;

      const [foreignSkill] = await pg.handle.db
        .insert(t.skills)
        .values({
          workspaceId: otherWorkspaceId,
          name: `foreign-skill-${Math.random().toString(36).slice(2, 8)}`,
          description: 'd',
          type: 'security',
          source: 'manual',
          body: 'b',
        })
        .returning();
      const foreignSkillId = foreignSkill!.id;

      try {
        const attempts = [
          {
            method: 'POST' as const,
            url: `/agents/${foreignAgentId}/context-docs`,
            payload: { repo_id: repoId, path: 'specs/api.md' },
          },
          {
            method: 'PUT' as const,
            url: `/agents/${foreignAgentId}/context-docs`,
            payload: { repo_id: repoId, paths: ['specs/api.md'] },
          },
          {
            method: 'DELETE' as const,
            url: `/agents/${foreignAgentId}/context-docs?path=specs%2Fapi.md&repo_id=${repoId}`,
          },
          {
            method: 'POST' as const,
            url: `/skills/${foreignSkillId}/context-docs`,
            payload: { repo_id: repoId, path: 'specs/api.md' },
          },
          {
            method: 'DELETE' as const,
            url: `/skills/${foreignSkillId}/context-docs?path=specs%2Fapi.md&repo_id=${repoId}`,
          },
        ];

        for (const attempt of attempts) {
          const res = await app.inject(attempt);
          expect(res.statusCode).toBe(404);
          expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
        }

        expect(await pg.handle.db.select().from(t.agentContextDocs)).toHaveLength(0);
        expect(await pg.handle.db.select().from(t.skillContextDocs)).toHaveLength(0);
      } finally {
        await pg.handle.db.delete(t.agents).where(eq(t.agents.id, foreignAgentId));
        await pg.handle.db.delete(t.skills).where(eq(t.skills.id, foreignSkillId));
        await app.close();
      }
    });
  });

  // ------------------------------------- the seed fixture (AC-56) -----------
  //
  // The run-trace half of SPEC-01 is unreachable in a seeded stack without this
  // fixture: `seed.ts` writes no `agent_runs` row, so the PR page's trace button
  // never renders. Asserted here rather than in a new suite because this file
  // already seeds a real database.
  describe('seed fixture', () => {
    it('seeds one run and one trace with a non-null project-context block, idempotently', async () => {
      // Re-run the whole seed: `pnpm db:seed` is run repeatedly on the same
      // database and must not accumulate runs.
      await seed(pg.handle.db);
      await seed(pg.handle.db);

      const runs = await pg.handle.db
        .select()
        .from(t.agentRuns)
        .where(eq(t.agentRuns.model, 'seed-trace'));
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe('done');
      expect(run.workspaceId).toBe(workspaceId);

      const traces = await pg.handle.db
        .select()
        .from(t.runTraces)
        .where(eq(t.runTraces.runId, run.id));
      expect(traces).toHaveLength(1);
      const trace = traces[0]!.trace as {
        prompt_assembly: { specs: string | null };
        specs_read: string[];
        specs_skipped: unknown;
      };

      // AC-56 — the project-context block is non-null and carries the path label.
      expect(trace.prompt_assembly.specs).toBeTruthy();
      expect(trace.prompt_assembly.specs).toContain(SEED_CONTEXT_PHRASE);
      expect(trace.prompt_assembly.specs).toContain('<untrusted source="specs/public-api.md">');
      expect(trace.specs_read).toEqual(['specs/public-api.md']);
      expect(trace.specs_skipped).toEqual([]);

      // The seeded review is linked to the run — without this the drawer opens
      // with zero findings and a null agent name (`page.tsx`'s lookup is over
      // *reviews*, keyed by `run_id`).
      const reviews = await pg.handle.db
        .select()
        .from(t.reviews)
        .where(eq(t.reviews.runId, run.id));
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews[0]!.agentId).toBe(run.agentId);
    });
  });
});
