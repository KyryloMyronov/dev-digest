import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import type { Db } from '../src/db/client.js';
import type { AuthProvider } from '@devdigest/shared';
import { modules } from '../src/modules/index.js';
import { BRIEF_DERIVE_JOB_KIND } from '../src/modules/brief/constants.js';

/**
 * SPEC-02 — the brief routes, via `app.inject()` with NO database.
 *
 * The DB is a recording stub: every awaited Drizzle chain resolves to the next
 * queued result (or the fallback). That is enough for the transport-level
 * criteria, and it is what lets AC-5 assert "without reaching the database" as
 * a fact rather than a hope. The DB-backed criteria (AC-1's populated case,
 * AC-3, AC-11, AC-12, AC-13, AC-19, AC-23, AC-28, AC-29) live in
 * `brief.it.test.ts`, where a real Postgres can disagree with us.
 */

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const AUTH: AuthProvider = {
  currentUser: async () => ({ id: 'user-1', email: 'dev@local', name: 'dev' }) as never,
  currentWorkspace: async () => ({ id: 'ws-1', name: 'default' }) as never,
};

const PULL_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws-1',
  repoId: 'repo-1',
  number: 482,
  title: 'Add rate limiting',
  branch: 'feat/rate-limit',
  base: 'main',
  headSha: 'abc1234',
  body: null,
};

const PR_ID = PULL_ROW.id;

/** A recording Drizzle stand-in. `queue` is consumed first, then `fallback`. */
function makeDb() {
  const calls: string[] = [];
  const queue: unknown[][] = [];
  let fallback: unknown[] = [];

  const chain = (): unknown =>
    new Proxy(function () {} as unknown as object, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(queue.length > 0 ? queue.shift() : fallback);
        }
        return () => chain();
      },
      apply: () => chain(),
    });

  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        calls.push(String(prop));
        return () => chain();
      },
    },
  ) as unknown as Db;

  return {
    db,
    calls,
    push: (rows: unknown[]) => queue.push(rows),
    setFallback: (rows: unknown[]) => {
      fallback = rows;
    },
  };
}

async function makeApp(over: Parameters<typeof buildApp>[0] = {}) {
  const stub = makeDb();
  const app = await buildApp({
    config,
    db: stub.db,
    overrides: { auth: AUTH, ...over.overrides },
    ...over,
  });
  // `buildApp` reaps stale runs on boot, which is a DB call of its own. Reset
  // the recorder so a test's assertions are about the request, not the boot.
  stub.calls.length = 0;
  return { app, stub };
}

// ------------------------------------------------------------------ registry

describe('module registration', () => {
  it('`brief` is in the static module registry', () => {
    expect(Object.keys(modules)).toContain('brief');
  });
});

// ------------------------------------------------------- GET /pulls/:id/brief

describe('GET /pulls/:id/brief', () => {
  it('AC-1 / R-9 — serialises a top-level null for a PR with no brief', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]); // findPull
    stub.push([]); //         getBrief → no row

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(200);
    // THE R-9 GATE: `PrBriefRecord.nullable()` as `response: { 200: … }` must
    // let a top-level `null` through `fastify-type-provider-zod`. If this ever
    // fails, the fallback is an envelope — which changes AC-52 and the MCP
    // projection, and comes back as a plan amendment rather than a silent fix.
    expect(res.body).toBe('null');
    expect(res.json()).toBeNull();
    await app.close();
  });

  it('AC-2 — serialises a stored record through the PrBriefRecord schema', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]);
    stub.push([
      {
        brief: {
          prId: PR_ID,
          json: {
            why: { summary: 'Public endpoints have no throttle.', sources: ['pr-title'] },
            risks: [
              {
                kind: 'concurrency',
                title: 'Process-local limiter store',
                explanation: 'With N instances the effective limit is N×.',
                severity: 'WARNING',
                file: 'src/config.ts',
                start_line: 12,
                end_line: 12,
              },
            ],
            focus: { entries: [{ file: 'src/config.ts', reason: 'check the window' }] },
            grounding: { kept: 2, dropped: 1 },
            omitted_files: ['src/huge.ts'],
          },
          provider: 'openai',
          model: 'gpt-4.1',
          tokensIn: 1200,
          tokensOut: 300,
          costUsd: null,
          headSha: 'abc1234',
          createdAt: null,
        },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pr_id).toBe(PR_ID);
    expect(body.risks[0].severity).toBe('WARNING');
    expect(body.grounding).toEqual({ kept: 2, dropped: 1 });
    expect(body.omitted_files).toEqual(['src/huge.ts']);
    // `null` survives as `null` — never coalesced to 0.
    expect(body.cost_usd).toBeNull();
    await app.close();
  });

  it('AC-60 — a payload the response schema rejects fails the request rather than being served', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]);
    // `prId` as a number drifts from `pr_id: z.string()`.
    stub.push([
      {
        brief: {
          prId: 12345,
          json: { risks: [], omitted_files: [] },
          provider: null,
          model: null,
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          headSha: null,
          createdAt: null,
        },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal_error');
    await app.close();
  });

  it('AC-4 — an unknown PR id 404s with the error envelope', async () => {
    const { app, stub } = await makeApp();
    stub.push([]); // findPull → nothing

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.message).toContain('Pull request');
    await app.close();
  });

  it('AC-5 — a non-uuid id is 422 WITHOUT reaching the database', async () => {
    const { app, stub } = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/brief' });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    // Half the criterion: validation ran BEFORE the handler, so no query issued.
    expect(stub.calls).toEqual([]);
    await app.close();
  });
});

// ------------------------------------------------------ POST /pulls/:id/brief

describe('POST /pulls/:id/brief', () => {
  it('AC-6 — 202 with the id of the enqueued job', async () => {
    const { app, stub } = await makeApp();
    // Replace the module's handler so the job does no work of its own; what is
    // under test here is the transport, not the derivation.
    app.container.jobs.register(BRIEF_DERIVE_JOB_KIND, async () => undefined);
    stub.push([PULL_ROW]); //     findPull
    stub.push([{ id: 'job-1' }]); // jobs insert … returning

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', jobId: 'job-1' });
    await app.close();
  });

  it('AC-7 — the response resolves while the derivation is still in flight', async () => {
    const { app, stub } = await makeApp();
    let started = false;
    let finished = false;
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    app.container.jobs.register(BRIEF_DERIVE_JOB_KIND, async () => {
      started = true;
      await blocked; // stands in for the pending model call
      finished = true;
    });
    stub.push([PULL_ROW]);
    stub.push([{ id: 'job-1' }]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });
    // Let the queue pick the job up, then check the response already landed.
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(202);
    expect(started).toBe(true);
    expect(finished).toBe(false);

    release();
    await app.container.jobs.onIdle();
    await app.close();
  });

  it('AC-8 — a degraded 202 receipt naming the reason when no handler is registered', async () => {
    const { app, stub } = await makeApp();
    // The genuine AC-8 path: `JobRunner.enqueue` throws when the kind has no
    // handler. Drop the one the routes plugin registered.
    (app.container.jobs as unknown as { handlers: Map<string, unknown> }).handlers.delete(
      BRIEF_DERIVE_JOB_KIND,
    );
    stub.push([PULL_ROW]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', degraded: true, reason: 'no_handler' });
    await app.close();
  });

  it('AC-4 — an unknown PR still 404s rather than being accepted and discarded', async () => {
    const { app, stub } = await makeApp();
    stub.push([]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('AC-5 — a non-uuid id is 422 without reaching the database', async () => {
    const { app, stub } = await makeApp();

    const res = await app.inject({ method: 'POST', url: '/pulls/nope/brief' });

    expect(res.statusCode).toBe(422);
    expect(stub.calls).toEqual([]);
    await app.close();
  });
});

// -------------------------------------------------------------------- AC-9

describe('AC-9 — the derivation endpoint is rate limited', () => {
  it('answers 429 on the sixth request inside one minute', async () => {
    // NON-STANDARD APP BUILD, on purpose. app.ts skips @fastify/rate-limit
    // under NODE_ENV=test so integration suites can hammer inject(). AC-9 is a
    // statement about the rate limit, so this test — and ONLY this test — must
    // register it. Everything else in this file uses the normal test config.
    // Its own app, closed separately: a leaked rate-limit store across tests is
    // a flake generator.
    const rlConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const stub = makeDb();
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({ config: rlConfig, db: stub.db, overrides: { auth: AUTH } });
      app.container.jobs.register(BRIEF_DERIVE_JOB_KIND, async () => undefined);
      stub.setFallback([PULL_ROW]);

      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/brief` });
        statuses.push(res.statusCode);
      }

      expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
      expect(statuses[5]).toBe(429);
    } finally {
      await app?.close();
    }
  });
});
