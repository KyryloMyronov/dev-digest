/**
 * project-context — token-count job unit tests (AC-36, AC-37, AC-38; NFR-4).
 *
 * Hermetic: a tmpdir stands in for the clone, an in-memory repository stub for
 * `context_doc_tokens`, and a mock `GitClient`/`Tokenizer` injected through the
 * container — never constructed inline, which is the whole reason the container
 * exists. No Postgres, no git.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Container } from '../../platform/container.js';
import type { Tokenizer } from '../../adapters/tokenizer/index.js';
import { approxTokens, TiktokenTokenizer } from '../../adapters/tokenizer/index.js';
import { ProjectContextService } from './service.js';
import type { ProjectContextRepository, TokenCountUpsert } from './repository.js';
import { MAX_CONTEXT_DOCUMENT_BYTES } from './constants.js';

const WS = 'ws-1';
const REPO_ID = 'repo-1';

interface StoredRow {
  contentHash: string;
  tokens: number;
}

function makeRepoStub(clonePath: string | null, seed: Record<string, StoredRow> = {}) {
  const rows = new Map<string, StoredRow>(Object.entries(seed));
  const writes: TokenCountUpsert[] = [];
  const stub = {
    repoForJob: async () =>
      clonePath === null
        ? null
        : { workspaceId: WS, owner: 'acme', name: 'payments-api', clonePath },
    cachedTokenRows: async () => new Map(rows),
    upsertTokenCount: async (v: TokenCountUpsert) => {
      writes.push(v);
      rows.set(v.path, { contentHash: v.contentHash, tokens: v.tokens });
    },
  };
  return { repo: stub as unknown as ProjectContextRepository, rows, writes };
}

/** A `GitClient` that reads the real tmpdir clone, like the production one. */
function makeContainer(root: string, tokenizer: Tokenizer): Container {
  return {
    db: {},
    git: {
      readFile: async (_ref: { owner: string; name: string }, p: string) =>
        (await import('node:fs/promises')).readFile(join(root, p), 'utf8'),
    },
    tokenizer,
    jobs: { register: vi.fn() },
  } as unknown as Container;
}

async function write(root: string, rel: string, contents: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

/** Cheap, deterministic counter for the behavioural cases — NOT tiktoken. The
    NFR-4 case below deliberately uses the real one. */
const stubTokenizer: Tokenizer = { count: (t) => Math.ceil(t.length / 3) };

describe('runTokenCountJob', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'project-context-tokens-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // AC-36 — one persisted count per document, keyed by content hash.
  it('persists one row per document with the tokenizer count and a content hash', async () => {
    await write(root, 'specs/a.md', 'alpha');
    await write(root, 'docs/b.md', 'beta beta');
    const { repo, writes, rows } = makeRepoStub(root);
    const svc = new ProjectContextService(makeContainer(root, stubTokenizer), repo);

    const res = await svc.runTokenCountJob({ repoId: REPO_ID });

    expect(res.counted).toBe(2);
    expect(res.unchanged).toBe(0);
    expect(res.remaining).toBe(0);
    expect(writes.map((w) => w.path).sort()).toEqual(['docs/b.md', 'specs/a.md']);
    expect(rows.get('specs/a.md')!.tokens).toBe(stubTokenizer.count('alpha'));
    // Every write is workspace-scoped and hash-keyed.
    for (const w of writes) {
      expect(w.workspaceId).toBe(WS);
      expect(w.repoId).toBe(REPO_ID);
      expect(w.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // AC-36's other half: the hash is what makes a re-scan cheap.
  it('skips a document whose stored content hash still matches', async () => {
    await write(root, 'specs/a.md', 'alpha');
    const first = makeRepoStub(root);
    const svc1 = new ProjectContextService(makeContainer(root, stubTokenizer), first.repo);
    await svc1.runTokenCountJob({ repoId: REPO_ID });

    // Second pass over the same, unchanged clone, seeded with the first result.
    const second = makeRepoStub(root, Object.fromEntries(first.rows));
    const svc2 = new ProjectContextService(makeContainer(root, stubTokenizer), second.repo);
    const res = await svc2.runTokenCountJob({ repoId: REPO_ID });

    expect(res.unchanged).toBe(1);
    expect(res.counted).toBe(0);
    expect(second.writes).toHaveLength(0);
  });

  it('recounts a document once its body changes', async () => {
    await write(root, 'specs/a.md', 'alpha');
    const first = makeRepoStub(root);
    await new ProjectContextService(makeContainer(root, stubTokenizer), first.repo).runTokenCountJob(
      { repoId: REPO_ID },
    );
    const hashBefore = first.rows.get('specs/a.md')!.contentHash;

    await write(root, 'specs/a.md', 'alpha and then some');
    const second = makeRepoStub(root, Object.fromEntries(first.rows));
    const res = await new ProjectContextService(
      makeContainer(root, stubTokenizer),
      second.repo,
    ).runTokenCountJob({ repoId: REPO_ID });

    expect(res.counted).toBe(1);
    expect(second.rows.get('specs/a.md')!.contentHash).not.toBe(hashBefore);
  });

  /**
   * AC-37 — a throwing tokenizer must yield the character estimate, not lose
   * the document. Only observable with a mock that actually throws:
   * `TiktokenTokenizer` catches internally, so production never reaches the
   * job's own fallback.
   */
  it('persists the character-based estimate when the tokenizer throws', async () => {
    const body = 'gamma '.repeat(50);
    await write(root, 'specs/a.md', body);
    const throwing: Tokenizer = {
      count: () => {
        throw new Error('BPE ranks unavailable');
      },
    };
    const { repo, rows } = makeRepoStub(root);

    const res = await new ProjectContextService(
      makeContainer(root, throwing),
      repo,
    ).runTokenCountJob({ repoId: REPO_ID });

    expect(res.counted).toBe(1);
    expect(rows.get('specs/a.md')!.tokens).toBe(approxTokens(body));
  });

  /**
   * AC-38 — a clipped budget persists what was computed and leaves the rest
   * uncounted. The clock is injected so this asserts the DECISION, not a race.
   */
  it('stops at the time budget, persisting the counts computed so far', async () => {
    for (let i = 0; i < 5; i += 1) await write(root, `specs/doc-${i}.md`, `body ${i}`);
    const { repo, rows, writes } = makeRepoStub(root);
    // The clock advances 10 ms per call. `startedAt` consumes t=0, then the
    // per-document check reads 10 ms (doc 0, admitted), 20 ms (doc 1, admitted)
    // and 30 ms (doc 2, at/over the 25 ms budget → stop). Three left uncounted.
    let t = 0;
    const svc = new ProjectContextService(makeContainer(root, stubTokenizer), repo);

    const res = await svc.runTokenCountJob(
      { repoId: REPO_ID },
      {
        budgetMs: 25,
        now: () => {
          const v = t;
          t += 10;
          return v;
        },
      },
    );

    expect(res.counted).toBe(2);
    expect(res.remaining).toBe(3);
    expect(writes).toHaveLength(2);
    // The remainder is genuinely absent — not zero, not stale.
    expect(rows.has('specs/doc-2.md')).toBe(false);
    expect(rows.has('specs/doc-4.md')).toBe(false);
  });

  it('does nothing when the repo has no clone', async () => {
    const { repo, writes } = makeRepoStub(null);
    const res = await new ProjectContextService(
      makeContainer(root, stubTokenizer),
      repo,
    ).runTokenCountJob({ repoId: REPO_ID });

    expect(res).toEqual({ counted: 0, unchanged: 0, remaining: 0, bytes: 0 });
    expect(writes).toHaveLength(0);
  });

  it('leaves an oversize document uncounted (it can never be injected, AC-49)', async () => {
    await write(root, 'specs/huge.md', 'x'.repeat(MAX_CONTEXT_DOCUMENT_BYTES + 1));
    await write(root, 'specs/small.md', 'ok');
    const { repo, writes } = makeRepoStub(root);

    await new ProjectContextService(makeContainer(root, stubTokenizer), repo).runTokenCountJob({
      repoId: REPO_ID,
    });

    expect(writes.map((w) => w.path)).toEqual(['specs/small.md']);
  });

  it('keeps going when one document cannot be read', async () => {
    await write(root, 'specs/a.md', 'alpha');
    await write(root, 'specs/b.md', 'beta');
    const { repo, writes } = makeRepoStub(root);
    const container = makeContainer(root, stubTokenizer);
    const original = container.git.readFile.bind(container.git);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (container.git as any).readFile = async (ref: never, p: string) => {
      if (p === 'specs/a.md') throw new Error('EACCES');
      return original(ref, p);
    };

    const res = await new ProjectContextService(container, repo).runTokenCountJob({
      repoId: REPO_ID,
    });

    expect(res.counted).toBe(1);
    expect(writes.map((w) => w.path)).toEqual(['specs/b.md']);
  });

  /**
   * NFR-4 — throughput is PRINTED, NOT ASSERTED (D-NFR4).
   *
   * The 10 MB/min expectation rests on a SINGLE local measurement of
   * `js-tiktoken@1.0.21` on Node 26 — above this repository's Node ≥ 22 floor —
   * over synthetic input, on one machine, with no upstream benchmark published
   * at any version. A threshold here would be a gate on a number nobody has
   * verified on the supported runtime, so this test records the figure and
   * asserts only that the job did the work.
   *
   * It uses the REAL `TiktokenTokenizer`, not the cheap stub the other cases
   * use — a figure measured against `Math.ceil(len/3)` would be a number about
   * nothing. The one-time BPE rank load is included in the elapsed time here,
   * whereas production pays it once per process (`container.ts` memoises with
   * `??=` and `app.ts` builds one Container per app), so the printed rate is a
   * FLOOR, not the steady-state rate.
   */
  it('reports token-count throughput over a synthetic corpus (NFR-4, printed only)', async () => {
    const docs = 12;
    const bodyBytes = 64 * 1024;
    for (let i = 0; i < docs; i += 1) {
      await write(root, `specs/perf-${i}.md`, `# doc ${i}\n${'lorem ipsum '.repeat(bodyBytes / 12)}`);
    }
    const { repo } = makeRepoStub(root);
    const svc = new ProjectContextService(
      makeContainer(root, new TiktokenTokenizer()),
      repo,
    );

    const t0 = performance.now();
    const res = await svc.runTokenCountJob({ repoId: REPO_ID });
    const elapsedMs = performance.now() - t0;

    const mbPerMin = (res.bytes / (1024 * 1024)) / (elapsedMs / 60_000);
    // eslint-disable-next-line no-console
    console.log(
      `[NFR-4] counted ${res.counted} docs, ${(res.bytes / 1024 / 1024).toFixed(2)} MB in ` +
        `${elapsedMs.toFixed(0)} ms → ${mbPerMin.toFixed(1)} MB/min (printed, not asserted)`,
    );

    expect(res.counted).toBe(docs);
  });
});
