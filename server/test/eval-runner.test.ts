import { describe, it, expect, beforeEach } from 'vitest';
import {
  runBatch,
  skillBlocksFor,
  type BatchCase,
  type RunBatchDeps,
  type RunBatchInput,
} from '../src/modules/eval/runner.js';
import type { EvalRepository, PersistedActualOutput } from '../src/modules/eval/repository.js';
import type { Container } from '../src/platform/container.js';
import type { Logger } from '../src/platform/logger.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * SPEC-04 step 12 — the batch runner.
 *
 * Hermetic: the repository is a recording stub and the provider is
 * `MockLLMProvider`, so nothing here needs Docker. The one thing this file
 * CANNOT prove is that no `agent_runs` row is written (AC-34) — a stub has no
 * table. It proves the structural half (nothing on this path can reach a run
 * writer) and `eval.it.test.ts` counts the rows.
 */

// ---------------------------------------------------------------- fixtures

const SENTINEL = 'sk_live_DO_NOT_LOG_THIS_SECRET';

const DIFF = (file: string, line = 12) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${line},2 +${line},3 @@`,
    ' const a = 1;',
    `+const k = "${SENTINEL}";`,
    ' const b = 2;',
  ].join('\n');

const FINDING = (file: string, line: number) => ({
  id: 'f1',
  severity: 'CRITICAL',
  category: 'security',
  title: 'Hardcoded key',
  file,
  start_line: line,
  end_line: line,
  rationale: 'A live key in source.',
  suggestion: null,
  confidence: 0.9,
});

const reviewFixture = (findings: unknown[]) => ({
  verdict: findings.length > 0 ? 'request_changes' : 'approve',
  summary: 'ok',
  score: findings.length > 0 ? 40 : 95,
  findings,
});

const CASE = (over: Partial<BatchCase> = {}): BatchCase => ({
  id: 'case-1',
  inputDiff: DIFF('src/pay.ts'),
  expectation: 'must_find',
  expectedOutput: [{ file: 'src/pay.ts', start_line: 13, end_line: 13 }],
  task: 'Review PR #42',
  ...over,
});

const AGENT = {
  id: 'agent-1',
  version: 7,
  provider: 'openai' as const,
  model: 'gpt-4.1',
  systemPrompt: 'You are a security reviewer.',
  strategy: 'single-pass' as const,
};

// ---------------------------------------------------------------- the doubles

interface SeededRow {
  id: string;
  caseId: string;
  batchId: string;
  agentId: string | null;
  agentVersion: number | null;
  trigger: string;
}

class StubRepo {
  seeded: SeededRow[] = [];
  completed: { runId: string; patch: Record<string, unknown> }[] = [];
  /** Every method name this stub was asked for — AC-34's structural half. */
  calls: string[] = [];

  /**
   * The rows the SERVICE seeded on the request, before the job was enqueued.
   * `runBatch` reads them; it does not create them.
   */
  seedFor(caseIds: readonly string[], batchId: string, agentId: string, version: number, trigger: string) {
    this.seeded = caseIds.map((caseId, i) => ({
      id: `run-${i + 1}`,
      caseId,
      batchId,
      agentId,
      agentVersion: version,
      trigger,
    }));
  }

  async runsForBatch(): Promise<SeededRow[]> {
    this.calls.push('runsForBatch');
    return this.seeded;
  }

  async completeRun(runId: string, patch: Record<string, unknown>): Promise<void> {
    this.calls.push('completeRun');
    this.completed.push({ runId, patch });
  }
}

const repoOf = (r: StubRepo) => r as unknown as EvalRepository;

class RecordingLog implements Logger {
  lines: { obj: unknown; msg?: string }[] = [];
  info = (obj: unknown, msg?: string) => void this.lines.push({ obj, msg });
  warn = (obj: unknown, msg?: string) => void this.lines.push({ obj, msg });
  error = (obj: unknown, msg?: string) => void this.lines.push({ obj, msg });
  debug = (obj: unknown, msg?: string) => void this.lines.push({ obj, msg });
}

/**
 * A port that records ANY property access. Stronger than counting method calls:
 * AC-31 says nothing on this path touches git or GitHub, and merely *reaching*
 * for `container.git` is already the violation.
 */
function recordingPort(touched: string[]): never {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        touched.push(String(prop));
        return () => undefined;
      },
    },
  ) as never;
}

interface Harness {
  container: Container;
  llm: MockLLMProvider;
  touchedGit: string[];
  touchedGithub: string[];
  repo: StubRepo;
  log: RecordingLog;
  links: { skill: Record<string, unknown>; order: number; enabled: boolean }[];
}

function harness(opts: { llm?: MockLLMProvider; maxUsd?: number; maxMs?: number } = {}): Harness {
  const llm = opts.llm ?? new MockLLMProvider('openai', { structured: reviewFixture([FINDING('src/pay.ts', 13)]) });
  const touchedGit: string[] = [];
  const touchedGithub: string[] = [];
  const repo = new StubRepo();
  const log = new RecordingLog();
  const links: Harness['links'] = [];
  const container = {
    config: {
      evalBatchMaxUsd: opts.maxUsd ?? 0.5,
      evalBatchMaxMs: opts.maxMs ?? 900_000,
    },
    llm: async () => llm,
    agentsRepo: { linkedSkills: async () => links },
    git: recordingPort(touchedGit),
    github: async () => recordingPort(touchedGithub),
  } as unknown as Container;
  return { container, llm, touchedGit, touchedGithub, repo, log, links };
}

/** Every message of the single structured call, joined — the assembled prompt. */
function promptOf(h: Harness): string {
  const req = h.llm.calls.find((c) => c.method === 'completeStructured')!.req as {
    messages: { role: string; content: string }[];
  };
  return req.messages.map((m) => m.content).join('\n');
}

/**
 * Seed the batch's rows the way the SERVICE does — on the request, before the
 * job — and then run it. `runBatch` reads pre-seeded rows; it does not create
 * them, because a batch has to be pollable from the moment its 202 lands.
 */
async function run(h: Harness, input: RunBatchInput, deps: RunBatchDeps) {
  h.repo.seedFor(
    input.cases.map((c) => c.id),
    input.batchId,
    input.agent.id,
    input.agent.version,
    input.trigger,
  );
  return runBatch(input, deps);
}

// ---------------------------------------------------------------- the tests

describe('AC-27 / AC-32 / AC-33 — a batch materialises one row per case', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('writes one row per case, sharing one batch_id, stamped with version and trigger', async () => {
    await run(h,
      {
        workspaceId: 'w',
        batchId: 'batch-1',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' })],
        trigger: 'manual',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );

    expect(h.repo.seeded).toHaveLength(2);
    expect(new Set(h.repo.seeded.map((r) => r.batchId))).toEqual(new Set(['batch-1']));
    // AC-32 — the agent's version at execution time, on EVERY row.
    expect(h.repo.seeded.every((r) => r.agentVersion === 7)).toBe(true);
    // AC-33 — trigger `manual` on every row of a manually-started batch.
    expect(h.repo.seeded.every((r) => r.trigger === 'manual')).toBe(true);
  });

  it('AC-90 — a version-change batch stamps `version-change` on every row', async () => {
    await run(h,
      {
        workspaceId: 'w',
        batchId: 'b',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' })],
        trigger: 'version-change',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(h.repo.seeded.every((r) => r.trigger === 'version-change')).toBe(true);
  });

  it('AC-31 / AC-34 — zero calls on the git and GitHub ports, and no run writer touched', async () => {
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    // AC-31 — the reviewed diff came from the case's frozen text, so neither
    // port can have been consulted.
    expect(h.touchedGit).toEqual([]);
    expect(h.touchedGithub).toEqual([]);
    // AC-34 — the only persistence this path performs is on eval_runs.
    expect(new Set(h.repo.calls)).toEqual(new Set(['runsForBatch', 'completeRun']));
  });
});

describe('AC-28 / AC-29 / AC-30 / AC-115 — the assembled prompt', () => {
  it('AC-29 — omits project context, repo map, callers, memory and intent', async () => {
    const h = harness();
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    const prompt = promptOf(h);
    for (const heading of ['Project context', 'Repository map', 'Callers', 'Memory', 'PR intent']) {
      expect(prompt).not.toContain(heading);
    }
  });

  it('AC-28 — carries the system prompt and the case’s frozen task', async () => {
    const h = harness();
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(promptOf(h)).toContain('You are a security reviewer.');
    expect(promptOf(h)).toContain('Review PR #42');
  });

  it('AC-115 — the frozen diff is fenced in <untrusted> (already true of the engine)', async () => {
    const h = harness();
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    const prompt = promptOf(h);
    const before = prompt.slice(0, prompt.indexOf(SENTINEL));
    expect(before).toContain('<untrusted');
    expect(before.lastIndexOf('<untrusted')).toBeGreaterThan(before.lastIndexOf('</untrusted>'));
  });

  it('AC-30 — one block per link where BOTH switches are true, in link order', () => {
    const skill = (name: string, enabled: boolean) => ({
      id: name,
      name,
      description: '',
      type: 'guideline',
      source: 'local',
      body: `body-${name}`,
      enabled,
      version: 1,
      evidenceFiles: null,
    });
    const blocks = skillBlocksFor([
      { skill: skill('a', true), order: 0, enabled: true },
      { skill: skill('b', true), order: 1, enabled: false }, // link muted
      { skill: skill('c', false), order: 2, enabled: true }, // skill disabled
      { skill: skill('d', true), order: 3, enabled: true },
    ] as never);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('body-a');
    expect(blocks[1]).toContain('body-d');
  });
});

describe('AC-113 / NFR-12 / NFR-16 — what a batch logs', () => {
  it('emits exactly one info line per case, with the ids and the metrics only', async () => {
    const h = harness();
    await run(h,
      {
        workspaceId: 'w',
        batchId: 'batch-9',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' })],
        trigger: 'manual',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(h.log.lines).toHaveLength(2);
    for (const line of h.log.lines) {
      expect(Object.keys(line.obj as object).sort()).toEqual([
        'batch_id',
        'case_id',
        'citation_accuracy',
        'precision',
        'recall',
      ]);
    }
  });

  it('never logs the frozen diff — the sentinel appears nowhere in the output', async () => {
    const h = harness();
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(JSON.stringify(h.log.lines)).not.toContain(SENTINEL);
    // ...and the sentinel really was on the path, so the assertion above can fail.
    expect(promptOf(h)).toContain(SENTINEL);
  });
});

describe('AC-36 / AC-111 / AC-58 — failure and cost', () => {
  it('AC-36 — a provider failure writes that row’s error and the batch continues', async () => {
    let n = 0;
    const llm = new MockLLMProvider('openai', { structured: reviewFixture([]) });
    const original = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => {
      n += 1;
      if (n === 1) throw new Error('provider 502: upstream unavailable');
      return original(req);
    };
    const h = harness({ llm });
    await run(h,
      {
        workspaceId: 'w',
        batchId: 'b',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' })],
        trigger: 'manual',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(h.repo.completed).toHaveLength(2);
    expect(h.repo.completed[0]!.patch.error).toContain('provider 502');
    expect(h.repo.completed[1]!.patch.error).toBeNull();
  });

  it('AC-58 — an unpriced model persists cost_usd null, never 0', async () => {
    const llm = new MockLLMProvider('openai', { structured: reviewFixture([]) });
    const original = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => ({ ...(await original(req)), costUsd: null });
    const h = harness({ llm });
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(h.repo.completed[0]!.patch.costUsd).toBeNull();
  });

  it('persists the scorer’s counts so the batch aggregate can micro-average', async () => {
    const h = harness();
    await run(h,
      { workspaceId: 'w', batchId: 'b', agent: AGENT, cases: [CASE()], trigger: 'manual' },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    const out = h.repo.completed[0]!.patch.actualOutput as PersistedActualOutput;
    expect(out.counts).toMatchObject({ expected: 1, actual: 1, matched: 1, noise: 0 });
  });
});

describe('AC-41 / AC-110 — the two ceilings both leave the batch partial', () => {
  it('AC-41 — stops BEFORE the case that would take the running total past the ceiling', async () => {
    // Every case costs 0.001 (MockLLMProvider's fixed price). With the ceiling at
    // 0.0015 the mean binds after case 1: 0.001 + 0.001 > 0.0015, so case 2 is
    // never called.
    const h = harness({ maxUsd: 0.0015 });
    const res = await run(h,
      {
        workspaceId: 'w',
        batchId: 'b',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' }), CASE({ id: 'case-3' })],
        trigger: 'manual',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(res.stoppedBy).toBe('cost_ceiling');
    // Three rows were SEEDED; only one was completed. The other two keep their
    // all-null row, which is what makes the batch derive as `partial`.
    expect(h.repo.seeded).toHaveLength(3);
    expect(h.repo.completed).toHaveLength(1);
  });

  it('AC-41 / OQ-6 — an unpriced model never binds the ceiling', async () => {
    const llm = new MockLLMProvider('openai', { structured: reviewFixture([]) });
    const original = llm.completeStructured.bind(llm);
    llm.completeStructured = async (req) => ({ ...(await original(req)), costUsd: null });
    const h = harness({ llm, maxUsd: 0.0000001 });
    const res = await run(h,
      {
        workspaceId: 'w',
        batchId: 'b',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' })],
        trigger: 'manual',
      },
      { container: h.container, repo: repoOf(h.repo), log: h.log },
    );
    expect(res.stoppedBy).toBeNull();
    expect(h.repo.completed).toHaveLength(2);
  });

  it('AC-110 — the wall clock stops the batch at the same checkpoint', async () => {
    const h = harness({ maxMs: 2_000 });
    let t = 0;
    const res = await run(h,
      {
        workspaceId: 'w',
        batchId: 'b',
        agent: AGENT,
        cases: [CASE(), CASE({ id: 'case-2' }), CASE({ id: 'case-3' })],
        trigger: 'manual',
      },
      // A fake clock: 1.5 s per call, so the second checkpoint is past 2 000 ms.
      { container: h.container, repo: repoOf(h.repo), log: h.log, now: () => (t += 1_500) },
    );
    expect(res.stoppedBy).toBe('wall_clock');
    expect(h.repo.completed.length).toBeLessThan(3);
  });
});
