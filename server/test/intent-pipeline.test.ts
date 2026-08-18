import { describe, it, expect, beforeEach } from 'vitest';
import type { PrIntentRecord, UnifiedDiff } from '@devdigest/shared';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { deriveIntent } from '../src/modules/reviews/intent-pipeline.js';
import { INTENT_SCHEMA_NAME } from '../src/modules/reviews/constants.js';
import type { ReviewRepository, PullRow } from '../src/modules/reviews/repository.js';
import type { Container } from '../src/platform/container.js';
import { RunLogger } from '../src/platform/run-logger.js';
import type { RunBus } from '../src/platform/sse.js';

/**
 * The intent pipeline, end to end, with NO database and NO real model.
 *
 * What is under test is the pipeline's own decisions — how many model calls it
 * makes, what it puts in them, what it refuses to persist, and how it behaves
 * when each dependency is missing. The contract it must hold in every one of
 * those cases is the same: NEVER THROW, and always say something.
 */

const WS = 'ws-1';

// -------------------------------------------------------------------- stubs

function makeBus() {
  const published: { kind: string; msg: string }[] = [];
  const bus = {
    publish: (_runId: string, kind: string, msg: string) => published.push({ kind, msg }),
    buffer: () => [],
    isCancelled: () => false,
    cancel: () => undefined,
    complete: () => undefined,
  } as unknown as RunBus;
  return { bus, published, log: () => new RunLogger(bus, ['run-1']) };
}

function makePull(over: Partial<PullRow> = {}): PullRow {
  return {
    id: 'pr-1',
    workspaceId: WS,
    repoId: 'repo-1',
    number: 482,
    title: 'Retry the nightly sync on 429',
    author: 'octocat',
    branch: 'fix/sync-retry',
    base: 'main',
    headSha: 'abc1234def',
    lastReviewedSha: null,
    additions: 20,
    deletions: 4,
    filesCount: 2,
    status: 'needs_review',
    body: null,
    openedAt: null,
    updatedAt: null,
    ...over,
  } as PullRow;
}

const REPO = {
  id: 'repo-1',
  owner: 'acme',
  name: 'payments-api',
  fullName: 'acme/payments-api',
  clonePath: '/tmp/clone',
} as never;

const DIFF: UnifiedDiff = {
  raw: 'diff --git a/src/sync.ts b/src/sync.ts',
  files: [{ path: 'src/sync.ts', additions: 20, deletions: 4, hunks: [] }],
};

const EXTRACTION = {
  intent: 'The nightly sync dies whenever upstream rate-limits; make it retry instead.',
  change_type: 'bugfix',
  in_scope: ['retry with backoff on 429'],
  out_of_scope: ['changing the sync schedule'],
  // A deliberately confident number: the cap is what must bring it down.
  confidence: 0.95,
  evidence: ['pr-body'],
};

function makeRepoStub(seed?: PrIntentRecord) {
  const state: { row?: PrIntentRecord } = { row: seed };
  const writes: unknown[] = [];
  const repo = {
    getIntent: async () => state.row,
    upsertIntent: async (_prId: string, values: unknown) => {
      writes.push(values);
    },
  } as unknown as ReviewRepository;
  return { repo, writes, state };
}

function makeContainer(opts: {
  llm?: MockLLMProvider;
  llmThrows?: boolean;
  provider?: 'openai' | 'openrouter';
  structuredOutputs?: boolean | null;
  githubThrows?: boolean;
  issueBody?: string;
  commits?: { message: string }[];
  specText?: string | Error;
} = {}): { container: Container; llm: MockLLMProvider } {
  const llm =
    opts.llm ?? new MockLLMProvider('openai', { structuredBySchema: { [INTENT_SCHEMA_NAME]: EXTRACTION } });
  const container = {
    // Verbose prompt logging off, as in a default local run: the pipeline reads
    // it to decide whether to pay for tokenizing every signal.
    config: { promptLogVerbose: false },
    tokenizer: { count: (text: string) => text.length },
    featureModel: async () => ({
      provider: opts.provider ?? 'openai',
      model: 'deepseek/deepseek-v4-flash',
    }),
    modelCatalog: { supportsStructuredOutputs: async () => opts.structuredOutputs ?? null },
    llm: async () => {
      if (opts.llmThrows) throw new Error('OPENROUTER_API_KEY is not configured');
      return llm;
    },
    pullsRepo: { listCommits: async () => opts.commits ?? [] },
    github: async () => {
      if (opts.githubThrows) throw new Error('GITHUB_TOKEN is not configured');
      return {
        getIssue: async (_ref: unknown, n: number) => ({
          number: n,
          title: 'Nightly sync fails on rate limit',
          body: opts.issueBody ?? 'Upstream returns 429 and we give up.',
          state: 'open',
        }),
      };
    },
    git: {
      readFile: async () => {
        if (opts.specText instanceof Error) throw opts.specText;
        return opts.specText ?? '# Plan\n\nAdd exponential backoff.';
      },
    },
  } as unknown as Container;
  return { container, llm };
}

/** The user message of the single structured call the pipeline makes. */
function userMessage(llm: MockLLMProvider): string {
  const call = llm.calls.find((c) => c.method === 'completeStructured');
  const req = call?.req as { messages: { role: string; content: string }[] };
  return req.messages.find((m) => m.role === 'user')!.content;
}

let bus: ReturnType<typeof makeBus>;
beforeEach(() => {
  bus = makeBus();
});

// --------------------------------------------------------------------------

describe('cache', () => {
  it('returns the cached row and makes NO model call when the head matches', async () => {
    const cached = {
      pr_id: 'pr-1',
      intent: 'cached intent',
      in_scope: [],
      out_of_scope: [],
      sources: ['title'],
      confidence: 0.4,
      derived_from: 'indirect',
      head_sha: 'abc1234def',
    } as PrIntentRecord;
    const { repo } = makeRepoStub(cached);
    const { container, llm } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.cached).toBe(true);
    expect(out.record?.intent).toBe('cached intent');
    expect(llm.calls).toHaveLength(0);
    expect(bus.published.some((e) => e.msg.includes('no model call'))).toBe(true);
  });

  it('re-derives when the head moved since the cached row', async () => {
    const stale = {
      pr_id: 'pr-1',
      intent: 'old intent',
      in_scope: [],
      out_of_scope: [],
      sources: ['title'],
      head_sha: 'OLDSHA',
    } as PrIntentRecord;
    const { repo, writes } = makeRepoStub(stale);
    const { container, llm } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.cached).toBeUndefined();
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect((writes[0] as { headSha: string }).headSha).toBe('abc1234def');
  });

  it('ignores the cache under force, even on a matching head', async () => {
    const { repo } = makeRepoStub({
      pr_id: 'pr-1',
      intent: 'cached',
      in_scope: [],
      out_of_scope: [],
      sources: [],
      head_sha: 'abc1234def',
    } as PrIntentRecord);
    const { container, llm } = makeContainer();

    await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
      force: true,
    });
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
  });
});

describe('confidence', () => {
  it('caps a confident model when only indirect signals were available', async () => {
    const { repo, writes } = makeRepoStub();
    const { container } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: null }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record?.derived_from).toBe('indirect');
    expect(out.record?.confidence).toBe(0.45);
    expect(out.record?.sources).toEqual(['title', 'branch', 'files']);
    expect((writes[0] as { confidence: number }).confidence).toBe(0.45);
  });

  it('lets a documented reading keep the model’s number', async () => {
    const { repo } = makeRepoStub();
    const { container } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: 'x'.repeat(400) }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record?.derived_from).toBe('documented');
    expect(out.record?.confidence).toBe(0.95);
  });

  it('does not let an unresolved ticket key lift the cap', async () => {
    const { repo } = makeRepoStub();
    const { container } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: 'ACME-123' }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record?.sources).toContain('ticket_key_unresolved');
    expect(out.record?.derived_from).toBe('indirect');
    expect(out.record?.confidence).toBe(0.45);
  });
});

describe('signals', () => {
  it('sends every gathered signal as its own untrusted block', async () => {
    const { repo } = makeRepoStub();
    const { container, llm } = makeContainer({
      commits: [{ message: 'fix: back off on 429' }],
    });

    await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: 'Closes #412. Implements docs/plans/retry.md' }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    const msg = userMessage(llm);
    for (const label of [
      'pr-title',
      'pr-body',
      'branch',
      'commits',
      'changed-files',
      'ticket',
      'spec:docs/plans/retry.md',
    ]) {
      expect(msg).toContain(`<untrusted source="${label}">`);
    }
  });

  it('sends file paths and counts, never the diff body', async () => {
    const { repo } = makeRepoStub();
    const { container, llm } = makeContainer();

    await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    const msg = userMessage(llm);
    expect(msg).toContain('src/sync.ts (+20/-4)');
    expect(msg).not.toContain('diff --git');
  });

  it('degrades when GitHub has no token, and says so', async () => {
    const { repo } = makeRepoStub();
    const { container } = makeContainer({ githubThrows: true });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: 'Closes #412' }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record).toBeDefined();
    expect(out.record?.sources).not.toContain('ticket');
    expect(bus.published.some((e) => e.msg.includes('#412 not resolved'))).toBe(true);
  });

  it('degrades when the plan file is not in the clone', async () => {
    const { repo } = makeRepoStub();
    const { container } = makeContainer({ specText: new Error('ENOENT') });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull({ body: 'see docs/plans/retry.md' }),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record).toBeDefined();
    expect(out.record?.sources.some((s) => s.startsWith('spec:'))).toBe(false);
    expect(bus.published.some((e) => e.msg.includes('not readable'))).toBe(true);
  });
});

describe('failure paths', () => {
  it('never throws and writes nothing when the model has no key', async () => {
    const { repo, writes } = makeRepoStub();
    const { container } = makeContainer({ llmThrows: true });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.reason).toBe('llm_unavailable');
    expect(out.record).toBeUndefined();
    expect(writes).toHaveLength(0);
    // The single most important assertion in this file: the ONLY record of a
    // failure is the log, so it must be loud enough to reach the user.
    expect(bus.published.some((e) => e.kind === 'error')).toBe(true);
  });

  it('blocks before spending a call when the model cannot do structured output', async () => {
    const { repo } = makeRepoStub();
    const { container, llm } = makeContainer({
      provider: 'openrouter',
      structuredOutputs: false,
    });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.reason).toBe('model_unsupported');
    expect(llm.calls).toHaveLength(0);
    expect(bus.published.some((e) => e.kind === 'error')).toBe(true);
  });

  it('proceeds when the catalogue does not know (null ≠ unsupported)', async () => {
    const { repo } = makeRepoStub();
    const { container, llm } = makeContainer({
      provider: 'openrouter',
      structuredOutputs: null,
    });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record).toBeDefined();
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
  });

  it('never throws when the model call itself fails', async () => {
    const { repo, writes } = makeRepoStub();
    const throwing = new MockLLMProvider('openai', {});
    throwing.completeStructured = async () => {
      throw new Error('502 upstream');
    };
    const { container } = makeContainer({ llm: throwing });

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.reason).toBe('llm_failed');
    expect(writes).toHaveLength(0);
    expect(bus.published.some((e) => e.kind === 'error')).toBe(true);
  });

  it('skips derivation entirely when every run was cancelled', async () => {
    const { repo } = makeRepoStub();
    const { container, llm } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
      isCancelled: () => true,
    });

    expect(out.reason).toBe('cancelled');
    expect(llm.calls).toHaveLength(0);
  });

  it('still returns the derivation when persisting it fails', async () => {
    const { repo } = makeRepoStub();
    (repo as unknown as { upsertIntent: () => Promise<void> }).upsertIntent = async () => {
      throw new Error('deadlock detected');
    };
    const { container } = makeContainer();

    const out = await deriveIntent(container, repo, {
      workspaceId: WS,
      pull: makePull(),
      repo: REPO,
      diff: DIFF,
      runLog: bus.log(),
    });

    expect(out.record).toBeDefined();
    expect(bus.published.some((e) => e.msg.includes('not persisted'))).toBe(true);
  });
});
