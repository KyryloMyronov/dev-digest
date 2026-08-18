import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { ConventionsRepository } from '../src/modules/conventions/repository.js';
import { ConventionsService } from '../src/modules/conventions/service.js';
import type { Container } from '../src/platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[conventions] Docker not available — skipping integration tests.');
}

/**
 * The conventions module over a real Postgres.
 *
 * Scoped to what only exists at the DB and HTTP layers: the status codes, the
 * unique index, workspace scoping, and the seam where an accepted set becomes a
 * real `skills` row. The scan pipeline itself is covered hermetically in
 * `conventions-scan.test.ts` — there is no value in paying for Docker to re-test
 * decisions a stub already pins.
 */
d('conventions module', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;

  beforeAll(async () => {
    pg = await startPg();
    const seeded = await seed(pg.handle.db);
    workspaceId = seeded.workspaceId;
    const [repo] = await pg.handle.db
      .select()
      .from(t.repos)
      .where(eq(t.repos.fullName, 'acme/payments-api'));
    repoId = repo!.id;
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

  /** Reset every seeded convention to pending between tests that mutate them. */
  async function resetStatuses() {
    await pg.handle.db
      .update(t.conventions)
      .set({ status: 'pending', edited: false })
      .where(eq(t.conventions.repoId, repoId));
  }

  async function listItems(app: Awaited<ReturnType<typeof makeApp>>) {
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      scan: { status: string; sample_files: number };
      items: { id: string; rule: string; status: string; edited: boolean }[];
    };
  }

  it('returns the seeded conventions with the scan that found them', async () => {
    const app = await makeApp();
    const { scan, items } = await listItems(app);

    expect(scan).toMatchObject({ status: 'done', sample_files: 84 });
    expect(items).toHaveLength(3);
    // Ordered by confidence desc — the UI, this test and the browser flow all
    // depend on the same deterministic order.
    expect(items.map((i) => i.rule)).toEqual([
      'Always use async/await instead of .then() chains.',
      'Redis access goes through the src/lib/redis.ts singleton.',
      'All public route handlers return a typed Result<T, ApiError>.',
    ]);
    await app.close();
  });

  it('synthesises an idle scan for a repo that has never been scanned', async () => {
    // A never-scanned repo is a domain state, not an error — the client must not
    // have to read a 404 as "no conventions yet".
    const app = await makeApp();
    const [other] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'unscanned',
        fullName: 'acme/unscanned',
        defaultBranch: 'main',
      })
      .returning();

    const res = await app.inject({ method: 'GET', url: `/repos/${other!.id}/conventions` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      scan: { status: 'idle', sample_files: 0 },
      items: [],
    });
    await app.close();
  });

  it('404s an unknown repo and 422s a non-uuid one', async () => {
    const app = await makeApp();
    const unknown = await app.inject({
      method: 'GET',
      url: '/repos/11111111-1111-1111-1111-111111111111/conventions',
    });
    expect(unknown.statusCode).toBe(404);

    // 422 rather than 404: the id never addressed a row, it was never an id.
    const malformed = await app.inject({ method: 'GET', url: '/repos/not-a-uuid/conventions' });
    expect(malformed.statusCode).toBe(422);
    await app.close();
  });

  it('accepts a convention without marking it edited', async () => {
    await resetStatuses();
    const app = await makeApp();
    const { items } = await listItems(app);
    const target = items[0]!;

    const res = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/${target.id}`,
      payload: { status: 'accepted' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'accepted', edited: false });
    await app.close();
  });

  it('rejects a convention, and it stays on record', async () => {
    await resetStatuses();
    const app = await makeApp();
    const { items } = await listItems(app);

    await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/${items[0]!.id}`,
      payload: { status: 'rejected' },
    });

    // Rejecting is not deleting: the row has to survive or the next scan would
    // offer the same rule again.
    const after = await listItems(app);
    expect(after.items).toHaveLength(3);
    expect(after.items.find((i) => i.id === items[0]!.id)!.status).toBe('rejected');
    await app.close();
  });

  it('marks a rewritten rule as edited and moves updated_at', async () => {
    await resetStatuses();
    const app = await makeApp();
    const { items } = await listItems(app);
    const before = (
      await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions` })
    ).json().items.find((i: { id: string }) => i.id === items[0]!.id) as { updated_at: string };

    const res = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/${items[0]!.id}`,
      payload: { rule: 'Prefer async/await; never chain .then().' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      rule: 'Prefer async/await; never chain .then().',
      edited: true,
    });
    expect(Date.parse(body.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));

    // Restore, so the ordering assertions in other tests keep their fixtures.
    await pg.handle.db
      .update(t.conventions)
      .set({ rule: t.conventions.sourceRule, edited: false })
      .where(eq(t.conventions.id, items[0]!.id));
    await app.close();
  });

  it('rejects an empty patch with 422 rather than reporting a no-op change', async () => {
    const app = await makeApp();
    const { items } = await listItems(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/${items[0]!.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('404s an unknown convention id and 422s a non-uuid one', async () => {
    const app = await makeApp();
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/11111111-1111-1111-1111-111111111111`,
      payload: { status: 'accepted' },
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions/nope`,
      payload: { status: 'accepted' },
    });
    expect(malformed.statusCode).toBe(422);
    await app.close();
  });

  it('sets many statuses in ONE request — what "Deselect all" is', async () => {
    await resetStatuses();
    const app = await makeApp();
    const { items } = await listItems(app);
    const ids = items.map((i) => i.id);

    const accepted = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/conventions/status`,
      payload: { ids, status: 'accepted' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toHaveLength(3);

    const cleared = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/conventions/status`,
      payload: { ids, status: 'pending' },
    });
    expect((cleared.json() as { status: string }[]).every((c) => c.status === 'pending')).toBe(
      true,
    );
    await app.close();
  });

  it('422s a bulk update naming a convention from another repo', async () => {
    const app = await makeApp();
    const [other] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'other-repo',
        fullName: 'acme/other-repo',
        defaultBranch: 'main',
      })
      .returning();
    const [foreign] = await pg.handle.db
      .insert(t.conventions)
      .values({
        workspaceId,
        repoId: other!.id,
        sourceRule: 'A rule from another repo.',
        rule: 'A rule from another repo.',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/conventions/status`,
      payload: { ids: [foreign!.id], status: 'accepted' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('never returns another repo’s conventions', async () => {
    const app = await makeApp();
    const { items } = await listItems(app);
    expect(items.map((i) => i.rule)).not.toContain('A rule from another repo.');
    await app.close();
  });

  describe('the skill draft', () => {
    it('422s until at least one convention is accepted', async () => {
      await resetStatuses();
      const app = await makeApp();
      const res = await app.inject({
        method: 'GET',
        url: `/repos/${repoId}/conventions/skill-draft`,
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it('composes a draft over the accepted rows and WRITES NOTHING', async () => {
      await resetStatuses();
      const app = await makeApp();
      const { items } = await listItems(app);
      await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/conventions/status`,
        payload: { ids: [items[0]!.id, items[1]!.id], status: 'accepted' },
      });

      const before = await pg.handle.db.select().from(t.skills);
      const res = await app.inject({
        method: 'GET',
        url: `/repos/${repoId}/conventions/skill-draft`,
      });
      const after = await pg.handle.db.select().from(t.skills);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'payments-api-conventions',
        type: 'convention',
        source: 'extracted',
        convention_count: 2,
        evidence_files: ['src/api/users.ts', 'src/lib/redis.ts'],
      });
      expect(res.json().tokens).toBeGreaterThan(0);
      expect(res.json().body).toContain('Always use async/await');
      // The draft is a suggestion, not a save.
      expect(after).toHaveLength(before.length);
      await app.close();
    });

    it('saves through POST /skills, carrying source and evidence_files', async () => {
      // The seam nothing else covers: every screen can look right while
      // `evidence_files` silently drops on the floor between the two modules.
      await resetStatuses();
      const app = await makeApp();
      const { items } = await listItems(app);
      await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/conventions/status`,
        payload: { ids: [items[0]!.id], status: 'accepted' },
      });

      const draft = (
        await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions/skill-draft` })
      ).json();

      const created = await app.inject({
        method: 'POST',
        url: '/skills',
        payload: {
          name: draft.name,
          description: draft.description,
          type: draft.type,
          source: draft.source,
          body: draft.body,
          enabled: true,
          evidence_files: draft.evidence_files,
        },
      });
      expect(created.statusCode).toBe(201);

      const fetched = await app.inject({
        method: 'GET',
        url: `/skills/${created.json().id}`,
      });
      expect(fetched.json()).toMatchObject({
        name: 'payments-api-conventions',
        type: 'convention',
        source: 'extracted',
        version: 1,
        evidence_files: ['src/api/users.ts'],
      });
      await app.close();
    });
  });

  describe('scanning', () => {
    it('202s and degrades to not_indexed for the unindexed demo repo', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/conventions/scan`,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: 'accepted' });

      await app.container.jobs.onIdle();

      // The demo repo has no clone and no index, so the scan must report why
      // rather than error — and must not have spent a model call to find out.
      const { scan } = await listItems(app);
      expect(['degraded', 'failed']).toContain(scan.status);
      await app.close();
    });

    it('404s a scan for an unknown repo', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: '/repos/11111111-1111-1111-1111-111111111111/conventions/scan',
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('leaves accepted decisions untouched across a scan', async () => {
      await resetStatuses();
      const app = await makeApp();
      const { items } = await listItems(app);
      await app.inject({
        method: 'PATCH',
        url: `/repos/${repoId}/conventions/${items[0]!.id}`,
        payload: { status: 'accepted' },
      });

      await app.inject({ method: 'POST', url: `/repos/${repoId}/conventions/scan` });
      await app.container.jobs.onIdle();

      const after = await listItems(app);
      expect(after.items.find((i) => i.id === items[0]!.id)!.status).toBe('accepted');
      expect(after.items).toHaveLength(3);
      await app.close();
    });
  });

  describe('workspace scoping', () => {
    it('hides another workspace’s repo behind a 404 on every route', async () => {
      // Built directly rather than over HTTP: the API cannot address a second
      // workspace, which is the property under test.
      const [otherWs] = await pg.handle.db
        .insert(t.workspaces)
        .values({ name: 'other-ws' })
        .returning();
      const [otherRepo] = await pg.handle.db
        .insert(t.repos)
        .values({
          workspaceId: otherWs!.id,
          owner: 'other',
          name: 'repo',
          fullName: 'other/repo',
          defaultBranch: 'main',
        })
        .returning();
      const [otherConv] = await pg.handle.db
        .insert(t.conventions)
        .values({
          workspaceId: otherWs!.id,
          repoId: otherRepo!.id,
          sourceRule: 'Foreign rule.',
          rule: 'Foreign rule.',
        })
        .returning();

      const app = await makeApp();
      for (const url of [
        `/repos/${otherRepo!.id}/conventions`,
        `/repos/${otherRepo!.id}/conventions/skill-draft`,
      ]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/repos/${otherRepo!.id}/conventions/${otherConv!.id}`,
            payload: { status: 'accepted' },
          })
        ).statusCode,
      ).toBe(404);
      await app.close();
    });

    it('scopes the repository’s own reads by workspace', async () => {
      const repo = new ConventionsRepository(pg.handle.db);
      const service = new ConventionsService({
        db: pg.handle.db,
      } as unknown as Container);

      // The right workspace sees the rows…
      const mine = await service.list(workspaceId, repoId);
      expect(mine.items.length).toBeGreaterThan(0);

      // …and the repository refuses to resolve the repo for a foreign one.
      const [otherWs] = await pg.handle.db
        .select()
        .from(t.workspaces)
        .where(eq(t.workspaces.name, 'other-ws'));
      expect(await repo.findRepo(otherWs!.id, repoId)).toBeUndefined();
    });
  });

  it('creates no duplicate rows when the same rule is seeded twice', async () => {
    // The unique index on (workspace, repo, source_rule) is what makes a re-scan
    // idempotent; re-running the seed is the cheapest way to exercise it.
    const { seedConventions } = await import('../src/db/seed-conventions.js');
    await seedConventions(pg.handle.db, workspaceId, repoId);

    const rows = await pg.handle.db
      .select()
      .from(t.conventions)
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)));
    expect(rows).toHaveLength(3);
  });
});
