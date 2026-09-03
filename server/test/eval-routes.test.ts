import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import evalRoutes from '../src/modules/eval/routes.js';
import { Container } from '../src/platform/container.js';
import { AppError } from '../src/platform/errors.js';
import { MAX_EXPECTED_FINDINGS, MAX_INPUT_DIFF_BYTES } from '../src/modules/eval/constants.js';

/**
 * SPEC-04 step 14 — the eval routes, without a database.
 *
 * NFR-5 (256 KB) and NFR-7 (20 entries) are ROUTE-level refusals, so they are
 * observable through `app.inject()` with no Docker: the body never reaches the
 * service.
 *
 * The four body-less action POSTs are the other reason this file exists. A
 * declared Zod `body:` schema REJECTS a body-less POST with 422
 * (`server/insights.md` 2026-08-29), and nothing but a real inject tells you
 * whether one was declared by accident. Those tests mount the plugin DIRECTLY
 * (`await evalRoutes(app)`, not `app.register`) so the `evalService` decorator
 * lands on an instance the test can reach — a registered plugin is encapsulated
 * and its decorators are invisible from outside.
 */

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const UUID = '00000000-0000-4000-8000-000000000001';

const DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -12,2 +12,3 @@',
  ' a',
  '+b',
  ' c',
].join('\n');

/** The full app — used wherever the ERROR ENVELOPE is part of the assertion. */
const fullApp = () =>
  buildApp({
    config,
    overrides: {
      llm: { openai: new MockLLMProvider('openai'), anthropic: new MockLLMProvider('anthropic') },
    },
  });

/**
 * A bare instance carrying the zod compilers and a REAL `Container` over a fake
 * db handle. Real, not a literal, because the routes resolve their service from
 * the composition root now — a hand-rolled container object would be a second
 * definition of the wiring and would pass while the real one was broken.
 */
async function mounted(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const container = new Container(config, {} as never, {
    auth: {
      currentUser: async () => ({ id: 'u', email: 'u@local', name: 'U' }),
      currentWorkspace: async () => ({ id: 'w', name: 'default' }),
    } as never,
  });
  app.decorate('container', container);
  // The same AppError → status mapping `app.ts` installs, and nothing else:
  // enough to assert a refusal's status code without a database behind it.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    reply.status(500).send({ error: { code: 'internal_error', message: String(err) } });
  });
  await evalRoutes(app);
  return app;
}

describe('NFR-7 / AC-109 / AC-20 — the 20-entry ceiling is a route refusal', () => {
  it('rejects a 21-entry expected_output with the failing Zod path in details', async () => {
    const a = await fullApp();
    const res = await a.inject({
      method: 'POST',
      url: `/agents/${UUID}/eval-cases`,
      payload: {
        owner_kind: 'agent',
        owner_id: UUID,
        name: 'too-many',
        input_diff: DIFF,
        expected_output: Array.from({ length: MAX_EXPECTED_FINDINGS + 1 }, (_, i) => ({
          file: 'a.ts',
          start_line: i + 1,
        })),
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('validation_error');
    // AC-20 — the failing PATH, not just a message.
    expect(JSON.stringify(body.error.details)).toContain('expected_output');
    await a.close();
  });

  it('rejects a wrong-shaped expected entry with its path', async () => {
    const a = await fullApp();
    const res = await a.inject({
      method: 'POST',
      url: `/agents/${UUID}/eval-cases`,
      payload: {
        owner_kind: 'agent',
        owner_id: UUID,
        name: 'bad-shape',
        input_diff: DIFF,
        expected_output: [{ file: 'a.ts', start_line: 'twelve' }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json().error.details)).toContain('start_line');
    await a.close();
  });

  it('AC-4 — a path id that is not a uuid never reaches the service', async () => {
    const a = await fullApp();
    const res = await a.inject({ method: 'GET', url: '/eval-cases/not-a-uuid' });
    expect(res.statusCode).toBe(422);
    await a.close();
  });
});

describe('the four action POSTs declare NO body schema', () => {
  const ACCEPTED = { status: 'accepted' as const, batch_id: UUID, cases: 1 };
  const cases = [
    { url: `/agents/${UUID}/eval-runs`, stub: { acceptAgentBatch: async () => ACCEPTED } },
    { url: `/eval-cases/${UUID}/runs`, stub: { acceptCaseRun: async () => ACCEPTED } },
    { url: '/eval/runs', stub: { acceptWorkspaceRun: async () => [ACCEPTED] } },
  ];

  for (const c of cases) {
    it(`POST ${c.url} answers 202 to a body-less request`, async () => {
      const a = await mounted();
      Object.assign(a.evalService, c.stub);
      const res = await a.inject({ method: 'POST', url: c.url });
      expect(res.statusCode).toBe(202);
      await a.close();
    });
  }

  it('POST /findings/:id/eval-case — the fourth one — also takes no body', async () => {
    const a = await mounted();
    Object.assign(a.evalService, {
      createCaseFromFinding: async () => ({
        case: {
          id: UUID,
          owner_kind: 'agent',
          owner_id: UUID,
          name: 'c',
          input_diff: DIFF,
          input_files: null,
          input_meta: null,
          expected_output: [],
          expectation: 'must_not_flag',
          notes: null,
        },
        created: true,
      }),
    });
    const res = await a.inject({ method: 'POST', url: `/findings/${UUID}/eval-case` });
    expect(res.statusCode).toBe(201);
    await a.close();
  });

  it('AC-16 — the idempotent repeat answers 200, not 201', async () => {
    const a = await mounted();
    Object.assign(a.evalService, {
      createCaseFromFinding: async () => ({
        case: {
          id: UUID,
          owner_kind: 'agent',
          owner_id: UUID,
          name: 'c',
          input_diff: DIFF,
          input_files: null,
          input_meta: null,
          expected_output: [],
          expectation: 'must_not_flag',
          notes: null,
        },
        created: false,
      }),
    });
    const res = await a.inject({ method: 'POST', url: `/findings/${UUID}/eval-case` });
    expect(res.statusCode).toBe(200);
    await a.close();
  });
});

describe('the route surface', () => {
  it('serves all thirteen paths, with `:id` under /agents and `:agentId` only under /eval', async () => {
    const a = await mounted();
    const tree = a.printRoutes({ commonPrefix: false });
    for (const path of [
      '/findings/:id/eval-case',
      '/agents/:id/eval-cases',
      '/agents/:id/eval-runs',
      '/eval-cases/:id',
      '/eval-cases/:id/runs',
      '/eval/runs',
      '/eval/estimate',
      '/eval/agents/:agentId',
    ]) {
      // printRoutes renders a TREE, so a full path is split across lines; the
      // radix segments are what is actually assertable.
      for (const seg of path.split('/').filter(Boolean)) {
        expect(tree).toContain(seg);
      }
    }
    // A find-my-way param conflict throws at REGISTRATION, so getting here at
    // all is the other half of the proof.
    expect(tree).not.toContain(':agentId/eval-cases');
    await a.close();
  });

  it('serves GET /eval and GET /agents/:id/eval-runs against their contracts', async () => {
    const a = await mounted();
    Object.assign(a.evalService, {
      workspaceDashboard: async () => ({ agents: [], batches: [], cases_total: 0 }),
      batchesForAgent: async () => [],
      estimate: async () => ({ agents: 0, cases: 0, est_cost_usd: null }),
    });
    expect((await a.inject({ method: 'GET', url: '/eval' })).statusCode).toBe(200);
    expect(
      (await a.inject({ method: 'GET', url: `/agents/${UUID}/eval-runs` })).statusCode,
    ).toBe(200);
    // `est_cost_usd: null` must survive serialization — a nullable number in a
    // response schema does serialise (server/insights.md 2026-08-28).
    const est = await a.inject({ method: 'GET', url: '/eval/estimate' });
    expect(est.json()).toEqual({ agents: 0, cases: 0, est_cost_usd: null });
    await a.close();
  });
});

describe('NFR-5 / AC-106 — the 256 KB diff ceiling', () => {
  it('rejects a 257 KB input_diff', async () => {
    const a = await mounted();
    Object.assign(a.evalService, {
      // The agent lookup is the service's first move; stubbing it isolates the
      // byte check, which is what AC-106 is about.
      requireAgent: async () => ({ id: UUID }),
    });
    const huge = `${DIFF}\n${'+x'.repeat(MAX_INPUT_DIFF_BYTES)}`;
    const res = await a.inject({
      method: 'POST',
      url: `/agents/${UUID}/eval-cases`,
      payload: {
        owner_kind: 'agent',
        owner_id: UUID,
        name: 'huge',
        input_diff: huge,
        expected_output: [{ file: 'src/pay.ts', start_line: 13 }],
      },
    });
    // Fastify's own 1 MB body cap is not what refuses this — 257 KB is well
    // inside it. The service's byte check is (AC-106).
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await a.close();
  });
});
