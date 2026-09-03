import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import type { Db } from '../src/db/client.js';
import type { AuthProvider } from '@devdigest/shared';
import { modules } from '../src/modules/index.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { FILE_SUMMARY_DERIVE_JOB_KIND } from '../src/modules/file-summary/constants.js';

/**
 * SPEC-03 — the file-summary routes, via `app.inject()` with NO database.
 *
 * The DB is a recording stub: every awaited Drizzle chain resolves to the next
 * queued result (or the fallback). That is enough for the transport-level
 * criteria, and it is what lets AC-6 assert "without reaching the database" as a
 * fact rather than a hope. The DB-backed criteria live in
 * `file-summary.it.test.ts`, where a real Postgres can disagree with us.
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

const FILE_ROWS = [
  { path: 'src/config.ts', additions: 40, deletions: 1, patch: '@@ -1 +1 @@\n+x' },
  { path: 'src/api/users.ts', additions: 20, deletions: 0, patch: '@@ -1 +1 @@\n+y' },
  { path: 'pnpm-lock.yaml', additions: 900, deletions: 10, patch: '@@ -1 +1 @@\n+lock' },
];

const STORED_ROW = {
  prId: PR_ID,
  path: 'src/config.ts',
  headSha: 'abc1234',
  summary: 'Adds a token-bucket limiter keyed on bucketKey.',
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4-flash',
  tokensIn: 1200,
  tokensOut: 25,
  costUsd: null,
  createdAt: new Date('2026-08-28T10:00:00.000Z'),
};

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
  const llm = new MockLLMProvider('openai', { structuredBySchema: {} });
  const app = await buildApp({
    config,
    db: stub.db,
    overrides: { auth: AUTH, llm: { openrouter: llm, openai: llm }, ...over.overrides },
    ...over,
  });
  // `buildApp` reaps stale runs on boot, which is a DB call of its own. Reset
  // the recorder so a test's assertions are about the request, not the boot.
  stub.calls.length = 0;
  return { app, stub, llm };
}

/** Count enqueues without touching the runner's behaviour (AC-14's other half). */
function countEnqueues(app: FastifyInstance) {
  const jobs = app.container.jobs as unknown as {
    enqueue: (...a: unknown[]) => Promise<unknown>;
  };
  const original = jobs.enqueue.bind(jobs);
  const counter = { n: 0 };
  jobs.enqueue = async (...a: unknown[]) => {
    counter.n++;
    return original(...a);
  };
  return counter;
}

// ------------------------------------------------------------------ registry

describe('module registration', () => {
  it('`fileSummary` is in the static module registry', () => {
    expect(Object.keys(modules)).toContain('fileSummary');
  });
});

// ---------------------------------------------- GET /pulls/:id/file-summaries

describe('GET /pulls/:id/file-summaries', () => {
  it('AC-1 — an empty list (and zeroed counts) for a PR with nothing derived', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]); // findPull
    stub.push([]); //         listSummaries
    stub.push([]); //         listFiles

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ summaries: [], omitted_files: [], selected: 0, total: 0 });
    await app.close();
  });

  it('AC-2 / AC-60 — a stored row serialises through PrFileSummariesResponse, with the counts', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]);
    stub.push([STORED_ROW]);
    stub.push(FILE_ROWS);

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summaries).toHaveLength(1);
    expect(body.summaries[0].path).toBe('src/config.ts');
    expect(body.summaries[0].head_sha).toBe('abc1234');
    // `null` survives as `null` — never coalesced to 0.
    expect(body.summaries[0].cost_usd).toBeNull();
    expect(body.summaries[0].created_at).toBe('2026-08-28T10:00:00.000Z');
    // `pnpm-lock.yaml` is boilerplate, so it is in neither the denominator nor
    // the omitted list (AC-18 means it is never a candidate).
    expect(body.total).toBe(2);
    expect(body.selected).toBe(1);
    expect(body.omitted_files).toEqual(['src/api/users.ts']);
    await app.close();
  });

  it('AC-3 — a payload the response schema rejects fails the request rather than being served', async () => {
    const { app, stub } = await makeApp();
    stub.push([PULL_ROW]);
    // `summary` as a number drifts from `summary: z.string()`.
    stub.push([{ ...STORED_ROW, summary: 12345 }]);
    stub.push(FILE_ROWS);

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal_error');
    await app.close();
  });

  it('AC-5 — an unknown PR id 404s with the error envelope', async () => {
    const { app, stub } = await makeApp();
    stub.push([]); // findPull → nothing

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.message).toContain('Pull request');
    await app.close();
  });

  it('AC-6 — a non-uuid id is 422 WITHOUT reaching the database', async () => {
    const { app, stub } = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/file-summaries' });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    // Half the criterion: validation ran BEFORE the handler, so no query issued.
    expect(stub.calls).toEqual([]);
    await app.close();
  });

  it('AC-7 — the read issues NO model request', async () => {
    const { app, stub, llm } = await makeApp();
    stub.push([PULL_ROW]);
    stub.push([STORED_ROW]);
    stub.push(FILE_ROWS);

    const res = await app.inject({ method: 'GET', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(200);
    expect(llm.calls).toHaveLength(0);
    await app.close();
  });
});

// --------------------------------------------- POST /pulls/:id/file-summaries

describe('POST /pulls/:id/file-summaries', () => {
  it('R-10 GATE / A-1 — a POST with NO BODY AT ALL is accepted with 202', async () => {
    // THE GATE (plan step 13), and the reason plan AMENDMENT A-1 exists.
    //
    // The studio's `apiFetch` sends body-less POSTs with no JSON content-type,
    // and Fastify hands the route `req.body === null` for those. A BARE
    // `body: FileSummaryDeriveInput` REJECTED that with a 422 — measured, not
    // assumed. The author's ruling was `.nullish()`, which accepts `null` and
    // still rejects a malformed body (the `path: 42` test below is the other
    // half of the pair, and neither is meaningful without it).
    //
    // Keep BOTH assertions: relaxing this one would silently re-open the gate.
    const { app, stub } = await makeApp();
    app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => undefined);
    stub.push([PULL_ROW]); //     findPull
    stub.push([{ id: 'job-1' }]); // jobs insert … returning

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', jobId: 'job-1' });
    await app.close();
  });

  it('AC-8 — 202 with the id of the enqueued job for an empty JSON body', async () => {
    const { app, stub } = await makeApp();
    app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => undefined);
    stub.push([PULL_ROW]);
    stub.push([{ id: 'job-1' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${PR_ID}/file-summaries`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', jobId: 'job-1' });
    await app.close();
  });

  it('AC-12 / AC-17 — a body carrying `path` and `force` is accepted', async () => {
    const { app, stub } = await makeApp();
    app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => undefined);
    stub.push([PULL_ROW]); //   findPull
    stub.push(FILE_ROWS); //    listFiles (AC-14's check)
    stub.push([{ id: 'job-2' }]);

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${PR_ID}/file-summaries`,
      payload: { path: 'src/config.ts', force: true },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', jobId: 'job-2' });
    await app.close();
  });

  it('a body whose `path` is not a string is 422 (the declared schema, doing its job)', async () => {
    const { app, stub } = await makeApp();
    stub.setFallback([PULL_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${PR_ID}/file-summaries`,
      payload: { path: 42 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('AC-14 — a `path` that is not a changed file is 422 with NO job enqueued', async () => {
    const { app, stub } = await makeApp();
    app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => undefined);
    const enqueues = countEnqueues(app);
    stub.push([PULL_ROW]); // findPull
    stub.push(FILE_ROWS); //  listFiles — does not contain the requested path

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${PR_ID}/file-summaries`,
      payload: { path: 'src/never-changed.ts' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    // "without enqueuing a job" is half the criterion.
    expect(enqueues.n).toBe(0);
    await app.close();
  });

  it('AC-9 — the response resolves while the derivation is still in flight', async () => {
    const { app, stub } = await makeApp();
    let started = false;
    let finished = false;
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => {
      started = true;
      await blocked; // stands in for the pending model call
      finished = true;
    });
    stub.push([PULL_ROW]);
    stub.push([{ id: 'job-1' }]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/file-summaries` });
    // Let the queue pick the job up, then check the response already landed.
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(202);
    expect(started).toBe(true);
    expect(finished).toBe(false);

    release();
    await app.container.jobs.onIdle();
    await app.close();
  });

  it('AC-10 — a degraded 202 receipt naming the reason when no handler is registered', async () => {
    const { app, stub } = await makeApp();
    // The genuine AC-10 path: `JobRunner.enqueue` throws when the kind has no
    // handler. Drop the one the routes plugin registered.
    (app.container.jobs as unknown as { handlers: Map<string, unknown> }).handlers.delete(
      FILE_SUMMARY_DERIVE_JOB_KIND,
    );
    stub.push([PULL_ROW]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', degraded: true, reason: 'no_handler' });
    await app.close();
  });

  it('AC-5 — an unknown PR still 404s rather than being accepted and discarded', async () => {
    const { app, stub } = await makeApp();
    stub.push([]);

    const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/file-summaries` });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('AC-6 — a non-uuid id is 422 without reaching the database', async () => {
    const { app, stub } = await makeApp();

    const res = await app.inject({ method: 'POST', url: '/pulls/nope/file-summaries' });

    expect(res.statusCode).toBe(422);
    expect(stub.calls).toEqual([]);
    await app.close();
  });
});

// -------------------------------------------------------------------- AC-11

describe('AC-11 / NFR-7 — the derivation endpoint is rate limited', () => {
  it('answers 429 on the eleventh request inside one minute', async () => {
    // NON-STANDARD APP BUILD, on purpose. `app.ts` skips @fastify/rate-limit
    // under NODE_ENV=test so integration suites can hammer inject(). AC-11 is a
    // statement ABOUT the rate limit, so this test — and ONLY this test — must
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
      app.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async () => undefined);
      stub.setFallback([PULL_ROW]);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({ method: 'POST', url: `/pulls/${PR_ID}/file-summaries` });
        statuses.push(res.statusCode);
      }

      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await app?.close();
    }
  });
});
