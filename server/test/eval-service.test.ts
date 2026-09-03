import { describe, it, expect, beforeEach } from 'vitest';
import { EvalService } from '../src/modules/eval/service.js';
import type { EvalRepository } from '../src/modules/eval/repository.js';
import type { Container } from '../src/platform/container.js';
import type { Logger } from '../src/platform/logger.js';
import { AppError, ConfigError } from '../src/platform/errors.js';
import type { EvalCaseInput } from '@devdigest/shared';

/**
 * SPEC-04 step 13 — the service's refusals and its 202 path.
 *
 * Hermetic. The repository is injected as a stub (the service takes one for
 * exactly this reason), so every criterion below is observable without Docker.
 */

const DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -12,2 +12,3 @@',
  ' const a = 1;',
  '+const k = 2;',
  ' const b = 2;',
].join('\n');

const BODY = (over: Partial<EvalCaseInput> = {}): EvalCaseInput => ({
  owner_kind: 'agent',
  owner_id: 'from-the-body-and-ignored',
  name: 'a-case',
  input_diff: DIFF,
  input_files: null,
  input_meta: null,
  expected_output: [{ file: 'src/pay.ts', start_line: 13, end_line: 13 }],
  expectation: 'must_find',
  notes: null,
  ...over,
});

const AGENT_ROW = {
  id: 'agent-1',
  name: 'Security Reviewer',
  version: 7,
  enabled: true,
  provider: 'openai',
  model: 'gpt-4.1',
  systemPrompt: 'p',
  strategy: 'auto',
};

const CASE_ROW = (over: Record<string, unknown> = {}) => ({
  id: 'case-1',
  workspaceId: 'w1',
  ownerKind: 'agent',
  ownerId: 'agent-1',
  name: 'a-case',
  inputDiff: DIFF,
  inputFiles: null,
  inputMeta: { task: 'Review PR #1' },
  expectedOutput: [{ file: 'src/pay.ts', start_line: 13, end_line: 13 }],
  expectation: 'must_find',
  notes: null,
  createdAt: new Date(),
  ...over,
});

class StubRepo {
  cases: Record<string, unknown>[] = [];
  inserted: Record<string, unknown>[] = [];
  sourceHit: Record<string, unknown> | undefined;
  async casesForOwner() {
    return this.cases;
  }
  async countCasesForOwner() {
    return this.cases.length;
  }
  async countCasesInWorkspace() {
    return this.cases.length;
  }
  async getCase(_w: string, id: string) {
    return this.cases.find((c) => c.id === id);
  }
  async insertCase(v: Record<string, unknown>) {
    this.inserted.push(v);
    return CASE_ROW({ ...v, id: `case-${this.inserted.length}` });
  }
  async updateCase(_w: string, id: string) {
    return this.cases.find((c) => c.id === id);
  }
  async deleteCase(_w: string, id: string) {
    return this.cases.some((c) => c.id === id);
  }
  async caseBySourceFinding() {
    return this.sourceHit;
  }
  async agentIdsWithCases(_w: string, ids: readonly string[]) {
    return new Set(ids);
  }
  async caseCountsByAgent() {
    return new Map([['agent-1', this.cases.length]]);
  }
  async meanPricedCaseCost() {
    return 0.02;
  }
  async batchesForAgent() {
    return [];
  }
  async batchesForWorkspace() {
    return [];
  }
  async seedBatch() {
    return [];
  }
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface H {
  svc: EvalService;
  repo: StubRepo;
  enqueued: { kind: string; payload: unknown }[];
  llmResolved: string[];
}

function harness(
  opts: {
    agent?: Record<string, unknown> | undefined;
    finding?: unknown;
    prFiles?: { path: string; patch: string | null }[];
    llmThrows?: boolean;
    enabledAgents?: Record<string, unknown>[];
  } = {},
): H {
  const repo = new StubRepo();
  const enqueued: { kind: string; payload: unknown }[] = [];
  const llmResolved: string[] = [];
  const agent = 'agent' in opts ? opts.agent : AGENT_ROW;
  const container = {
    db: {},
    config: { evalBatchMaxUsd: 0.5, evalBatchMaxMs: 900_000 },
    jobs: {
      register: () => {},
      enqueue: async (_w: string, kind: string, payload: unknown) => {
        enqueued.push({ kind, payload });
        return { id: 'job-1', done: Promise.resolve() };
      },
    },
    agentsRepo: {
      getById: async () => agent,
      list: async () => (agent ? [agent] : []),
      listEnabled: async () => opts.enabledAgents ?? (agent ? [agent] : []),
      linkedSkills: async () => [],
    },
    reviewRepo: {
      findingContext: async () => opts.finding,
      getPrFiles: async () => opts.prFiles ?? [],
    },
    llm: async (id: string) => {
      llmResolved.push(id);
      if (opts.llmThrows) throw new ConfigError('OPENAI_API_KEY is not configured');
      return {};
    },
  } as unknown as Container;
  return {
    svc: new EvalService(container, noopLog, repo as unknown as EvalRepository),
    repo,
    enqueued,
    llmResolved,
  };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-error';
  } catch (e) {
    return e instanceof AppError ? `${e.code}:${e.statusCode}` : `unknown:${String(e)}`;
  }
};

// ======================================================================

describe('AC-3 / AC-4 — tenancy and the owner-kind refusal', () => {
  it('AC-4 — an unknown or foreign agent is 404, never 403', async () => {
    const h = harness({ agent: undefined });
    expect(await codeOf(h.svc.listCases('w1', 'agent-1'))).toBe('not_found:404');
    expect(await codeOf(h.svc.createCase('w1', 'agent-1', BODY()))).toBe('not_found:404');
  });

  it('AC-4 — a case from another workspace is 404 (the stub scopes by workspace)', async () => {
    const h = harness();
    expect(await codeOf(h.svc.getCase('w1', 'case-of-another-workspace'))).toBe('not_found:404');
  });

  it('AC-3 — owner_kind `skill` is a 422 validation_error', async () => {
    const h = harness();
    expect(await codeOf(h.svc.createCase('w1', 'agent-1', BODY({ owner_kind: 'skill' })))).toBe(
      'validation_error:422',
    );
  });
});

describe('AC-114 — mass assignment', () => {
  it('takes owner and workspace from the context and the path, never from the body', async () => {
    const h = harness();
    await h.svc.createCase('w1', 'agent-1', BODY({ owner_id: 'someone-elses-agent' }));
    expect(h.repo.inserted[0]).toMatchObject({
      workspaceId: 'w1',
      ownerKind: 'agent',
      ownerId: 'agent-1',
    });
    // The body's owner_id reached the service and was NOT used.
    expect(h.repo.inserted[0]!.ownerId).not.toBe('someone-elses-agent');
  });
});

describe('AC-22 / AC-23 / AC-24 / AC-106 / AC-107 — the body rules', () => {
  it('AC-23 — must_find with an empty expected_output is 422', async () => {
    const h = harness();
    expect(
      await codeOf(h.svc.createCase('w1', 'agent-1', BODY({ expected_output: [] }))),
    ).toBe('validation_error:422');
  });

  it('AC-22 — must_not_flag with an empty expected_output is accepted', async () => {
    const h = harness();
    const c = await h.svc.createCase(
      'w1',
      'agent-1',
      BODY({ expectation: 'must_not_flag', expected_output: [] }),
    );
    expect(c.expectation).toBe('must_not_flag');
  });

  it('AC-24 — a diff that parses to zero files is 422', async () => {
    const h = harness();
    expect(
      await codeOf(h.svc.createCase('w1', 'agent-1', BODY({ input_diff: '   \n not a diff' }))),
    ).toBe('validation_error:422');
  });

  it('AC-106 — a diff past 256 KB is 422', async () => {
    const h = harness();
    const huge = `${DIFF}\n${'+x'.repeat(200_000)}`;
    expect(await codeOf(h.svc.createCase('w1', 'agent-1', BODY({ input_diff: huge })))).toBe(
      'validation_error:422',
    );
  });

  it('AC-107 — the 51st case for an agent is 422', async () => {
    const h = harness();
    h.repo.cases = Array.from({ length: 50 }, (_, i) => CASE_ROW({ id: `c${i}` }));
    expect(await codeOf(h.svc.createCase('w1', 'agent-1', BODY()))).toBe('validation_error:422');
  });
});

describe('AC-16 / AC-17 / AC-18 — a case from a finding', () => {
  const PR_FILES = [{ path: 'src/pay.ts', patch: '@@ -12,2 +12,3 @@\n a\n+b\n c' }];
  const ctx = (over: Record<string, unknown> = {}) => ({
    finding: {
      id: 'f-1',
      file: 'src/pay.ts',
      startLine: 13,
      endLine: 13,
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded key',
      acceptedAt: new Date(),
      dismissedAt: null,
    },
    review: { agentId: 'agent-1' },
    pull: { id: 'p1', workspaceId: 'w1', number: 42, title: 'Add checkout', headSha: 'abc' },
    ...over,
  });

  it('AC-16 — a second click returns the existing case with created: false', async () => {
    const h = harness({ finding: ctx(), prFiles: PR_FILES });
    h.repo.sourceHit = CASE_ROW();
    const r = await h.svc.createCaseFromFinding('w1', 'f-1');
    expect(r.created).toBe(false);
    expect(h.repo.inserted).toHaveLength(0);
  });

  it('AC-17 — a finding whose file is absent from its PR diff is 422', async () => {
    const h = harness({
      finding: ctx({
        finding: { ...ctx().finding, file: 'src/elsewhere.ts' },
      }),
      prFiles: PR_FILES,
    });
    expect(await codeOf(h.svc.createCaseFromFinding('w1', 'f-1'))).toBe('validation_error:422');
  });

  it('AC-18 — a review with no agent_id is 422', async () => {
    const h = harness({ finding: ctx({ review: { agentId: null } }), prFiles: PR_FILES });
    expect(await codeOf(h.svc.createCaseFromFinding('w1', 'f-1'))).toBe('validation_error:422');
  });

  it('AC-4 — a finding on another workspace’s PR is 404', async () => {
    const h = harness({
      finding: ctx({ pull: { ...ctx().pull, workspaceId: 'w2' } }),
      prFiles: PR_FILES,
    });
    expect(await codeOf(h.svc.createCaseFromFinding('w1', 'f-1'))).toBe('not_found:404');
  });

  it('AC-7 / AC-10 / AC-11 / AC-12 — the persisted row', async () => {
    const h = harness({ finding: ctx(), prFiles: PR_FILES });
    const r = await h.svc.createCaseFromFinding('w1', 'f-1');
    expect(r.created).toBe(true);
    const row = h.repo.inserted[0]!;
    expect(row.expectation).toBe('must_find');
    expect(row.inputMeta).toMatchObject({ head_sha: 'abc', source_finding_ids: ['f-1'] });
    expect(String(row.inputDiff)).toContain('src/pay.ts');
  });
});

describe('AC-27 / AC-35 / AC-39 / AC-40 — the 202 path, in order', () => {
  let h: H;
  beforeEach(() => {
    h = harness();
    h.repo.cases = [CASE_ROW()];
  });

  it('AC-27 — enqueues one eval-batch job and returns the accepted body', async () => {
    const r = await h.svc.acceptAgentBatch('w1', 'agent-1');
    expect(r).toMatchObject({ status: 'accepted', cases: 1, agent_id: 'agent-1' });
    expect(typeof r.batch_id).toBe('string');
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.kind).toBe('eval-batch');
    expect(h.enqueued[0]!.payload).toMatchObject({ trigger: 'manual', batchId: r.batch_id });
  });

  it('AC-35 — an agent with zero cases is 422 and enqueues nothing', async () => {
    h.repo.cases = [];
    expect(await codeOf(h.svc.acceptAgentBatch('w1', 'agent-1'))).toBe('validation_error:422');
    expect(h.enqueued).toHaveLength(0);
  });

  it('AC-40 — a second batch for the same agent is 422', async () => {
    await h.svc.acceptAgentBatch('w1', 'agent-1');
    expect(await codeOf(h.svc.acceptAgentBatch('w1', 'agent-1'))).toBe('validation_error:422');
    expect(h.enqueued).toHaveLength(1);
  });

  it('AC-39 — an unresolvable provider key is config_error 500 BEFORE any enqueue', async () => {
    const bad = harness({ llmThrows: true });
    bad.repo.cases = [CASE_ROW()];
    expect(await codeOf(bad.svc.acceptAgentBatch('w1', 'agent-1'))).toBe('config_error:500');
    expect(bad.enqueued).toHaveLength(0);
    // ...and the agent is not left wedged by the failed attempt (AC-40 would
    // otherwise refuse it forever).
    expect(bad.svc.activeBatches().size).toBe(0);
  });

  it('AC-116 / D-9 — a single-case run is a one-case batch on the same path', async () => {
    const r = await h.svc.acceptCaseRun('w1', 'case-1');
    expect(r.cases).toBe(1);
    expect(h.enqueued[0]!.payload).toMatchObject({ caseIds: ['case-1'] });
  });

  it('the accepted batch reads as active until the handler clears it', async () => {
    const r = await h.svc.acceptAgentBatch('w1', 'agent-1');
    expect(h.svc.activeBatches().has(r.batch_id!)).toBe(true);
  });
});

describe('AC-42 / AC-43 — the workspace-wide run', () => {
  it('AC-43 — one batch per enabled agent that has at least one case', async () => {
    const h = harness({
      enabledAgents: [AGENT_ROW, { ...AGENT_ROW, id: 'agent-2' }],
    });
    h.repo.cases = [CASE_ROW()];
    const out = await h.svc.acceptWorkspaceRun('w1');
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.status === 'accepted')).toBe(true);
    expect(h.enqueued).toHaveLength(2);
  });

  it('AC-42 — a DISABLED agent is excluded (listEnabled is the only source)', async () => {
    const h = harness({ enabledAgents: [] });
    h.repo.cases = [CASE_ROW()];
    expect(await h.svc.acceptWorkspaceRun('w1')).toEqual([]);
    expect(h.enqueued).toHaveLength(0);
  });

  it('an agent whose provider key is missing is SKIPPED as degraded, not fatal', async () => {
    const h = harness({ llmThrows: true, enabledAgents: [AGENT_ROW] });
    h.repo.cases = [CASE_ROW()];
    const out = await h.svc.acceptWorkspaceRun('w1');
    expect(out).toEqual([
      {
        status: 'accepted',
        batch_id: null,
        cases: 0,
        degraded: true,
        reason: 'config_error',
        agent_id: 'agent-1',
      },
    ]);
  });
});

describe('AC-72 — the cost estimate', () => {
  it('multiplies the mean priced case cost by the case count', async () => {
    const h = harness();
    h.repo.cases = [CASE_ROW(), CASE_ROW({ id: 'case-2' })];
    const est = await h.svc.estimate('w1');
    expect(est).toEqual({ agents: 1, cases: 2, est_cost_usd: 0.04 });
  });

  it('reports null — never 0 — when no priced batch exists to extrapolate from', async () => {
    const h = harness();
    h.repo.cases = [CASE_ROW()];
    h.repo.meanPricedCaseCost = async () => null;
    expect((await h.svc.estimate('w1')).est_cost_usd).toBeNull();
  });
});

describe('job registration deadline', () => {
  it('the batch kind registers with EVAL_BATCH_MAX_MS plus the headroom, not the 120 s default', () => {
    // The regression this pins: `new JobRunner(db)` defaults to 120 s, one case
    // on a slow model is ~67 s, and a seven-case batch went `failed` in `jobs`
    // two minutes in while it ran on for six more.
    const registered: { kind: string; timeoutMs?: number }[] = [];
    const container = {
      db: {},
      config: { evalBatchMaxUsd: 0.5, evalBatchMaxMs: 900_000 },
      jobs: {
        register: (kind: string, _fn: unknown, opts?: { timeoutMs?: number }) =>
          void registered.push({ kind, timeoutMs: opts?.timeoutMs }),
      },
    } as unknown as Container;
    const svc = new EvalService(container, noopLog, new StubRepo() as unknown as EvalRepository);
    svc.registerJobHandlers();
    expect(registered).toEqual([{ kind: 'eval-batch', timeoutMs: 900_000 + 300_000 }]);
    expect(svc.jobTimeoutMs()).toBeGreaterThan(900_000);
  });
});
