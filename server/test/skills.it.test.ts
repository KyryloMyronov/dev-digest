import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { SkillsService } from '../src/modules/skills/service.js';
import { SkillsRepository } from '../src/modules/skills/repository.js';
import type { Container } from '../src/platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills] Docker not available — skipping integration tests.');
}

/**
 * The skills library + an agent's links, over a real Postgres.
 *
 * Covers the behaviours that only exist at the DB layer and that the unit tests
 * for the pure helpers cannot reach: the body-versioning rule, the separation of
 * "attached" from "enabled" across a reorder, the FK cascade from a deleted
 * skill into `agent_skills`, and workspace scoping on both.
 */
d('skills module', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
  }

  const body = (name: string) => ({
    name,
    description: 'Apply when the diff adds a conditional. Report every branch.',
    type: 'rubric' as const,
    body: '# Rule\n\nOriginal body.',
  });

  async function createAgent(app: Awaited<ReturnType<typeof makeApp>>, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name,
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        system_prompt: 'Review the diff.',
      },
    });
    return res.json().id as string;
  }

  // ---- CRUD + versioning ---------------------------------------------------

  it('creates a skill at v1 and defaults its source to manual', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/skills', payload: body('crud-v1') });
    expect(res.statusCode).toBe(201);
    // 'manual' is not something a caller can accidentally omit its way out of —
    // an unlabelled skill must never look locally authored by default.
    expect(res.json()).toMatchObject({ version: 1, source: 'manual', enabled: true });

    const versions = (
      await app.inject({ method: 'GET', url: `/skills/${res.json().id}/versions` })
    ).json();
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, body: '# Rule\n\nOriginal body.' }),
    ]);
    await app.close();
  });

  it('records the declared source for an import', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { ...body('crud-imported'), source: 'imported_url' },
    });
    expect(res.json().source).toBe('imported_url');
    await app.close();
  });

  it('a body edit bumps the version and keeps the old body in history', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('crud-bump') })
    ).json().id as string;

    const updated = await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { body: '# Rule\n\nRewritten.' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);

    const versions = (await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0].body).toBe('# Rule\n\nRewritten.');
    expect(versions[1].body).toBe('# Rule\n\nOriginal body.');
    await app.close();
  });

  it('a metadata-only edit does NOT create a version', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('crud-meta') })
    ).json().id as string;

    await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { name: 'crud-meta-renamed', type: 'security', enabled: false },
    });

    const versions = (await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json();
    expect(versions).toHaveLength(1);
    await app.close();
  });

  it('re-saving an unchanged body does not manufacture a version', async () => {
    const app = await makeApp();
    const payload = body('crud-nochange');
    const id = (await app.inject({ method: 'POST', url: '/skills', payload })).json().id as string;

    await app.inject({ method: 'PUT', url: `/skills/${id}`, payload: { body: payload.body } });

    expect(
      (await app.inject({ method: 'GET', url: `/skills/${id}/versions` })).json(),
    ).toHaveLength(1);
    await app.close();
  });

  it('404s for an unknown skill on every read and write', async () => {
    const app = await makeApp();
    const ghost = '00000000-0000-0000-0000-000000000000';
    for (const [method, url] of [
      ['GET', `/skills/${ghost}`],
      ['GET', `/skills/${ghost}/versions`],
      ['GET', `/skills/${ghost}/agents`],
      ['DELETE', `/skills/${ghost}`],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    expect(
      (
        await app.inject({ method: 'PUT', url: `/skills/${ghost}`, payload: { name: 'x' } })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('rejects a non-uuid id at the edge (422, not 404)', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/skills/not-a-uuid' })).statusCode).toBe(422);
    await app.close();
  });

  // ---- Links: attached vs enabled ------------------------------------------

  it('attaches skills in order, enabled by default', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Order Agent');
    const a = (await app.inject({ method: 'POST', url: '/skills', payload: body('link-a') })).json()
      .id as string;
    const b = (await app.inject({ method: 'POST', url: '/skills', payload: body('link-b') })).json()
      .id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: b }, { skill_id: a }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { skill_id: b, order: 0, enabled: true },
      { skill_id: a, order: 1, enabled: true },
    ]);
    // The skill is inlined so the tab needs no second request per row.
    expect(res.json()[0].skill.name).toBe('link-b');
    await app.close();
  });

  it('PATCH toggles ONE link without disturbing the order', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Toggle Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('toggle-a') })
    ).json().id as string;
    const b = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('toggle-b') })
    ).json().id as string;
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: a }, { skill_id: b }] },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}/skills/${a}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { skill_id: a, order: 0, enabled: false },
      { skill_id: b, order: 1, enabled: true },
    ]);
    await app.close();
  });

  it('a reorder that carries enabled:false keeps the link disabled', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Reorder Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('reorder-a') })
    ).json().id as string;
    const b = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('reorder-b') })
    ).json().id as string;
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: a, enabled: false }, { skill_id: b }] },
    });

    // Swap the two, restating both flags — the shape the Skills tab sends.
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: b, enabled: true }, { skill_id: a, enabled: false }] },
    });
    expect(res.json()).toMatchObject([
      { skill_id: b, order: 0, enabled: true },
      { skill_id: a, order: 1, enabled: false },
    ]);
    await app.close();
  });

  it('the order-only shorthand attaches everything enabled', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Shorthand Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('shorthand-a') })
    ).json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [a] },
    });
    expect(res.json()).toMatchObject([{ skill_id: a, order: 0, enabled: true }]);
    await app.close();
  });

  it('DELETE unlinks one skill and leaves the skill itself alone', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Unlink Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('unlink-a') })
    ).json().id as string;
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: a }] },
    });

    const res = await app.inject({ method: 'DELETE', url: `/agents/${agentId}/skills/${a}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/skills/${a}` })).statusCode).toBe(200);
    await app.close();
  });

  it('404s when toggling a link the agent does not have', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Link Missing Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('missing-a') })
    ).json().id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}/skills/${a}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // ---- Deletion cascade + the delete warning -------------------------------

  it('/skills/:id/agents names the agents a delete would affect', async () => {
    const app = await makeApp();
    const agentId = await createAgent(app, 'Zed Consumer');
    const a = (await app.inject({ method: 'POST', url: '/skills', payload: body('used-a') })).json()
      .id as string;
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: a }] },
    });

    const res = await app.inject({ method: 'GET', url: `/skills/${a}/agents` });
    expect(res.json()).toContain('Zed Consumer');
    await app.close();
  });

  it('deleting a skill cascades its links and its version history', async () => {
    const app = await makeApp();
    const { db } = pg.handle;
    const agentId = await createAgent(app, 'Cascade Agent');
    const a = (
      await app.inject({ method: 'POST', url: '/skills', payload: body('cascade-a') })
    ).json().id as string;
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { links: [{ skill_id: a }] },
    });

    expect((await app.inject({ method: 'DELETE', url: `/skills/${a}` })).statusCode).toBe(200);

    expect(
      await db.select().from(t.agentSkills).where(eq(t.agentSkills.skillId, a)),
    ).toHaveLength(0);
    expect(
      await db.select().from(t.skillVersions).where(eq(t.skillVersions.skillId, a)),
    ).toHaveLength(0);
    // The agent survives; it simply has one fewer skill.
    expect((await app.inject({ method: 'GET', url: `/agents/${agentId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/agents/${agentId}/skills` })).json()).toEqual(
      [],
    );
    await app.close();
  });

  // ---- Tenancy -------------------------------------------------------------

  it('skills are workspace-scoped on read, write and delete', async () => {
    const { db } = pg.handle;
    const [otherWs] = await db.insert(t.workspaces).values({ name: 'other-skills' }).returning();
    const repo = new SkillsRepository(db);
    const foreign = await repo.insert({
      workspaceId: otherWs!.id,
      name: 'foreign-skill',
      description: 'd',
      type: 'custom',
      source: 'manual',
      body: '# foreign',
    });

    const service = new SkillsService({ db } as unknown as Container);
    const [{ id: defaultWs }] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));

    expect(await service.get(otherWs!.id, foreign.id)).toBeDefined();
    expect(await service.get(defaultWs!, foreign.id)).toBeUndefined();
    expect(await service.listVersions(defaultWs!, foreign.id)).toBeUndefined();
    expect(await service.update(defaultWs!, foreign.id, { name: 'hijacked' })).toBeUndefined();
    expect(await service.delete(defaultWs!, foreign.id)).toBe(false);
    // Still there, still named as it was.
    expect((await service.get(otherWs!.id, foreign.id))?.name).toBe('foreign-skill');
  });

  it('linkedAgentNames does not leak an agent from another workspace', async () => {
    const { db } = pg.handle;
    const [otherWs] = await db
      .insert(t.workspaces)
      .values({ name: 'other-linkers' })
      .returning();
    const [{ id: defaultWs }] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));

    // A skill in the default workspace, linked by an agent in ANOTHER one. The
    // link table has no workspace column, so the query has to join through
    // `agents` — this is the assertion that catches losing that join.
    const repo = new SkillsRepository(db);
    const shared = await repo.insert({
      workspaceId: defaultWs!,
      name: 'shared-skill',
      description: 'd',
      type: 'custom',
      source: 'manual',
      body: '# shared',
    });
    const [foreignAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId: otherWs!.id,
        name: 'Foreign Linker',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'x',
      })
      .returning();
    await db
      .insert(t.agentSkills)
      .values({ agentId: foreignAgent!.id, skillId: shared.id, order: 0 });

    expect(await repo.linkedAgentNames(defaultWs!, shared.id)).toEqual([]);
    expect(await repo.linkedAgentNames(otherWs!.id, shared.id)).toEqual(['Foreign Linker']);

    // Sanity: the link really is there, so the empty result above is the scope
    // filter working rather than a missing row.
    expect(
      await db
        .select()
        .from(t.agentSkills)
        .where(
          and(eq(t.agentSkills.skillId, shared.id), eq(t.agentSkills.agentId, foreignAgent!.id)),
        ),
    ).toHaveLength(1);
  });
});
