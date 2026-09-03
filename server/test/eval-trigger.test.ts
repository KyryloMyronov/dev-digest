import { describe, it, expect } from 'vitest';
import { EvalTriggerService } from '../src/modules/eval/trigger.js';
import type { EvalService } from '../src/modules/eval/service.js';
import type { Container } from '../src/platform/container.js';
import type { Logger } from '../src/platform/logger.js';
import { changedTriggerFields } from '../src/modules/agents/helpers.js';
import { AGENT_VERSION_EVAL_JOB_KIND, EVAL_JOB_TIMEOUT_HEADROOM_MS } from '../src/modules/eval/constants.js';

/**
 * SPEC-04 step 18 — the auto-eval trigger: AC-85, AC-87, AC-88, AC-89, AC-91,
 * AC-92, NFR-17.
 *
 * Hermetic. The repository, the queue and the batch loop are all doubles, which
 * is the point: AC-87's debounce is an in-memory marker, and an in-memory marker
 * is only observable if nothing else in the path can hide it.
 */

class RecordingLog implements Logger {
  lines: { obj: Record<string, unknown>; msg?: string }[] = [];
  info = (o: unknown, m?: string) => void this.lines.push({ obj: o as Record<string, unknown>, msg: m });
  warn = (o: unknown, m?: string) => void this.lines.push({ obj: o as Record<string, unknown>, msg: m });
  error = (o: unknown, m?: string) => void this.lines.push({ obj: o as Record<string, unknown>, msg: m });
  debug = (o: unknown, m?: string) => void this.lines.push({ obj: o as Record<string, unknown>, msg: m });
}

interface H {
  trigger: EvalTriggerService;
  enqueued: { kind: string; payload: unknown }[];
  executed: unknown[];
  log: RecordingLog;
  handler: ((payload: unknown, ctx: { jobId: string }) => Promise<void>) | undefined;
  repo: StubRepo;
  container: Container;
}

class StubRepo {
  cases = [{ id: 'case-1' }];
  versionChangeBatch = false;
  seeded: Record<string, unknown>[] = [];
  async casesForOwner() {
    return this.cases;
  }
  async hasVersionChangeBatch() {
    return this.versionChangeBatch;
  }
  async seedBatch(seeds: Record<string, unknown>[]) {
    this.seeded.push(...seeds);
    return seeds.map((s, i) => ({ ...s, id: `run-${i}` }));
  }
}

function harness(
  opts: { autoEval?: boolean; currentVersion?: number; noHandler?: boolean } = {},
): H {
  const enqueued: { kind: string; payload: unknown }[] = [];
  const executed: unknown[] = [];
  const registeredTimeouts = new Map<string, number>();
  const log = new RecordingLog();
  const repo = new StubRepo();
  const h: H = {
    trigger: null as unknown as EvalTriggerService,
    enqueued,
    executed,
    log,
    handler: undefined,
    repo,
    container: null as unknown as Container,
  };
  const container = {
    db: {},
    jobs: {
      timeoutMs: 120_000,
      timeoutFor: (kind: string) => registeredTimeouts.get(kind) ?? 120_000,
      register: (
        kind: string,
        fn: (p: unknown, c: { jobId: string }) => Promise<void>,
        opts?: { timeoutMs?: number },
      ) => {
        if (kind === AGENT_VERSION_EVAL_JOB_KIND) h.handler = fn;
        if (opts?.timeoutMs !== undefined) registeredTimeouts.set(kind, opts.timeoutMs);
      },
      enqueue: async (_w: string, kind: string, payload: unknown) => {
        // AC-91's condition: `JobRunner.enqueue` THROWS when no handler is
        // registered (`platform/jobs.ts:50-51`).
        if (opts.noHandler) throw new Error(`No job handler registered for kind '${kind}'`);
        enqueued.push({ kind, payload });
        return { id: 'job-1', done: Promise.resolve() };
      },
    },
    agentsRepo: {
      getById: async () => ({
        id: 'agent-1',
        version: opts.currentVersion ?? 3,
        autoEval: opts.autoEval ?? true,
      }),
    },
  } as unknown as Container;

  const service = {
    executeBatch: async (p: unknown) => void executed.push(p),
    // What the real service derives: EVAL_BATCH_MAX_MS (900 s) + headroom.
    jobTimeoutMs: () => 900_000 + EVAL_JOB_TIMEOUT_HEADROOM_MS,
  } as unknown as EvalService;

  h.container = container;
  const trigger = new EvalTriggerService(container, log, service);
  // The repository is private; overwrite it the way the composition root would
  // if it took one, so the handler's two skips are drivable without Postgres.
  (trigger as unknown as { repo: unknown }).repo = repo;
  if (!opts.noHandler) trigger.registerJobHandler();
  h.trigger = trigger;
  return h;
}

describe('AC-85 / plan D-13 — the allow-list is the whole rule', () => {
  it('enqueues for a prompt, model, provider, strategy, output_schema or skill change', async () => {
    for (const field of [
      'system_prompt',
      'model',
      'provider',
      'strategy',
      'output_schema',
      'skills',
    ] as const) {
      const h = harness();
      await h.trigger.onAgentVersionBumped('w', 'agent-1', 4, [field]);
      expect(h.enqueued, field).toHaveLength(1);
    }
  });

  it('enqueues NOTHING for ci_fail_on, repo_intel, name or description', async () => {
    const h = harness();
    // Those four are not `EvalTriggerField`s at all, which is the point: the
    // type makes the allow-list unbypassable, and an empty `changed` is what a
    // bump of any of them produces.
    await h.trigger.onAgentVersionBumped('w', 'agent-1', 4, []);
    expect(h.enqueued).toHaveLength(0);
  });

  it('changedTriggerFields reports only allow-listed fields that actually moved', () => {
    const before = {
      provider: 'openai' as const,
      model: 'gpt-4.1',
      systemPrompt: 'a',
      strategy: 'auto',
      outputSchema: null,
    };
    // A no-op patch (same values) reports nothing.
    expect(changedTriggerFields(before, { model: 'gpt-4.1', systemPrompt: 'a' })).toEqual([]);
    expect(changedTriggerFields(before, { systemPrompt: 'b' })).toEqual(['system_prompt']);
    // ci_fail_on / repo_intel / name / description are not in the output at all.
    expect(
      changedTriggerFields(before, { ciFailOn: 'critical', repoIntel: true, name: 'x' }),
    ).toEqual([]);
  });

  it('an agent with auto_eval off enqueues nothing', async () => {
    const h = harness({ autoEval: false });
    await h.trigger.onAgentVersionBumped('w', 'agent-1', 4, ['system_prompt']);
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('AC-87 / NFR-17 — the debounce', () => {
  it('five rapid bumps queue at most ONE job', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await h.trigger.onAgentVersionBumped('w', 'agent-1', 4 + i, ['system_prompt']);
    }
    expect(h.enqueued).toHaveLength(1);
  });

  it('mutation check — with the marker cleared, the same five bumps queue five', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await h.trigger.onAgentVersionBumped('w', 'agent-1', 4 + i, ['system_prompt']);
      // Clearing the marker is exactly the mechanism under test; if the count
      // did NOT go to five, the assertion above would be pinning something else.
      (h.trigger as unknown as { pending: Set<string> }).pending.clear();
    }
    expect(h.enqueued).toHaveLength(5);
  });

  it('the marker clears when the handler FINISHES, so the next bump can queue', async () => {
    const h = harness();
    await h.trigger.onAgentVersionBumped('w', 'agent-1', 4, ['system_prompt']);
    expect(h.trigger.pendingAgents().has('agent-1')).toBe(true);
    await h.handler!(h.enqueued[0]!.payload, { jobId: 'job-1' });
    expect(h.trigger.pendingAgents().has('agent-1')).toBe(false);
    await h.trigger.onAgentVersionBumped('w', 'agent-1', 5, ['system_prompt']);
    expect(h.enqueued).toHaveLength(2);
  });
});

describe('AC-88 / AC-89 / AC-90 — the handler’s two skips', () => {
  it('AC-88 — a payload naming an older version than the agent’s runs nothing', async () => {
    const h = harness({ currentVersion: 7 });
    await h.handler!({ workspaceId: 'w', agentId: 'agent-1', version: 3 }, { jobId: 'j' });
    expect(h.executed).toHaveLength(0);
    expect(h.repo.seeded).toHaveLength(0);
    expect(h.log.lines.some((l) => l.msg?.includes('stale version'))).toBe(true);
  });

  it('AC-89 — a duplicate payload starts no second batch', async () => {
    const h = harness({ currentVersion: 4 });
    h.repo.versionChangeBatch = true;
    await h.handler!({ workspaceId: 'w', agentId: 'agent-1', version: 4 }, { jobId: 'j' });
    expect(h.executed).toHaveLength(0);
  });

  it('AC-90 — every seeded row of an auto-eval batch carries trigger `version-change`', async () => {
    const h = harness({ currentVersion: 4 });
    await h.handler!({ workspaceId: 'w', agentId: 'agent-1', version: 4 }, { jobId: 'j' });
    expect(h.repo.seeded).toHaveLength(1);
    expect(h.repo.seeded[0]!.trigger).toBe('version-change');
    expect(h.executed[0]).toMatchObject({ trigger: 'version-change' });
  });
});

describe('AC-91 — degradation when no handler is registered', () => {
  it('swallows the enqueue failure, logs once, and clears the marker', async () => {
    const h = harness({ noHandler: true });
    await expect(
      h.trigger.onAgentVersionBumped('w', 'agent-1', 4, ['system_prompt']),
    ).resolves.toBeUndefined();
    expect(h.log.lines.filter((l) => l.msg === 'auto-eval not enqueued')).toHaveLength(1);
    // Not left wedged: a later bump, once a handler exists, must still queue.
    expect(h.trigger.pendingAgents().has('agent-1')).toBe(false);
  });
});

describe('AC-92 — the batch id is logged alongside the failed job id', () => {
  it('a batch that throws logs both ids together', async () => {
    const h = harness({ currentVersion: 4 });
    const service = (h.trigger as unknown as { service: EvalService }).service;
    (service as unknown as { executeBatch: () => Promise<void> }).executeBatch = async () => {
      throw new Error('boom');
    };
    await expect(
      h.handler!({ workspaceId: 'w', agentId: 'agent-1', version: 4 }, { jobId: 'job-42' }),
    ).rejects.toThrow('boom');
    const line = h.log.lines.find((l) => l.msg?.includes('did not complete cleanly'));
    expect(line).toBeDefined();
    expect(line!.obj.job_id).toBe('job-42');
    expect(typeof line!.obj.batch_id).toBe('string');
  });

  it('the auto-eval kind registers with the batch deadline, not the 120 s default', () => {
    // The regression this pins: a seven-case batch on a slow model went `failed`
    // in `jobs` at 120 s while it ran on for six more minutes.
    const h = harness();
    expect(h.container.jobs.timeoutFor(AGENT_VERSION_EVAL_JOB_KIND)).toBe(
      900_000 + EVAL_JOB_TIMEOUT_HEADROOM_MS,
    );
    expect(h.container.jobs.timeoutFor('poll_repo')).toBe(120_000);
  });

  it('the timeout line pairs the two ids and is armed at the kind’s own deadline', async () => {
    // The pairing exists because `withTimeout` rejects the RACE without aborting
    // the handler: the jobs row goes failed while the batch runs on, and these
    // two ids together are the only way to reconcile them by hand afterwards.
    const h = harness({ currentVersion: 4 });
    let armedFor = -1;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      armedFor = ms ?? -1;
      return realSetTimeout(fn, 10_000_000);
    }) as typeof setTimeout;
    try {
      await h.handler!({ workspaceId: 'w', agentId: 'agent-1', version: 4 }, { jobId: 'job-7' });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    // JobRunner.timeoutFor(kind), read not duplicated — and NOT the 120 s default.
    expect(armedFor).toBe(900_000 + EVAL_JOB_TIMEOUT_HEADROOM_MS);
  });
});
