/**
 * project-context run-start resolver — hermetic unit tests.
 *
 * Covers AC-21, AC-22, AC-39, AC-40, AC-43, AC-45, AC-47, AC-48, AC-49, AC-50
 * plus NFR-1 (timed) and NFR-2 (counted). A tmpdir stands in for the clone and a
 * mock `GitClient` reads it, so there is no Postgres, no git and no clock
 * dependence beyond the two explicit timing tests.
 *
 * The stubs are structural on purpose: the resolver takes `ContextLinkReader` /
 * `LinkedSkillsReader` rather than the concrete repository classes, which is
 * what makes AC-39's "the resolver call's arguments against a mock repository"
 * observable at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile as readFileFs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  planContextDocs,
  resolveContextForRun,
  type ContextLinkReader,
  type LinkedSkillLike,
  type LinkedSkillsReader,
  type ResolverDeps,
} from './resolver.js';
import { PROJECT_CONTEXT_TOKEN_BUDGET } from './constants.js';

const WS = 'ws-1';
const AGENT = 'agent-1';
const REF = { repoOwner: 'acme', repoName: 'payments-api' };
const INPUT = { workspaceId: WS, agentId: AGENT, ...REF };

/** `agent_context_docs` / `skill_context_docs`, in memory. */
function links(opts: {
  agent?: string[];
  bySkill?: Record<string, string[]>;
  throwOnAgentDocs?: boolean;
}): ContextLinkReader {
  return {
    agentDocs: async () => {
      if (opts.throwOnAgentDocs) throw new Error('connection terminated unexpectedly');
      return (opts.agent ?? []).map((path, order) => ({ path, order }));
    },
    docsForSkills: async (_ws, ids) => {
      const out = new Map<string, { path: string; order: number }[]>();
      for (const id of ids) {
        const paths = opts.bySkill?.[id];
        if (paths) out.set(id, paths.map((path, order) => ({ path, order })));
      }
      return out;
    },
  };
}

/** `container.agentsRepo`, in memory. `order` is the order the rows arrive in. */
function agents(rows: Partial<LinkedSkillLike>[] = []): LinkedSkillsReader {
  return {
    linkedSkills: async () =>
      rows.map((r, i) => ({
        skill: { id: r.skill?.id ?? `skill-${i}`, name: r.skill?.name ?? `Skill ${i}`, enabled: r.skill?.enabled ?? true },
        order: r.order ?? i,
        enabled: r.enabled ?? true,
      })),
  };
}

async function write(root: string, rel: string, contents: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

function gitFor(root: string, overrides: { readFile?: ResolverDeps['git']['readFile'] } = {}) {
  return {
    clonePathFor: () => root,
    readFile:
      overrides.readFile ??
      (async (_ref: { owner: string; name: string }, p: string) =>
        (await import('node:fs/promises')).readFile(join(root, p), 'utf8')),
  };
}

describe('planContextDocs — order and dedupe', () => {
  // AC-21 — the agent's own attachments first in persisted order, then each
  // enabled skill's documents in skill order.
  it('places the agent\'s own attachments before skill-inherited ones', async () => {
    const planned = await planContextDocs(
      {
        links: links({
          agent: ['specs/own-b.md', 'specs/own-a.md'],
          bySkill: { 's1': ['docs/from-s1.md'], 's2': ['docs/from-s2.md'] },
        }),
        agents: agents([
          { skill: { id: 's1', name: 'Security', enabled: true } },
          { skill: { id: 's2', name: 'Perf', enabled: true } },
        ]),
      },
      { workspaceId: WS, agentId: AGENT },
    );

    expect(planned.map((p) => p.path)).toEqual([
      'specs/own-b.md',
      'specs/own-a.md',
      'docs/from-s1.md',
      'docs/from-s2.md',
    ]);
    // AC-23's data half: an inherited row names its skill; an own row does not.
    expect(planned.map((p) => p.inheritedFrom)).toEqual([
      undefined,
      undefined,
      'Security',
      'Perf',
    ]);
  });

  // AC-22 — first occurrence wins, so an agent-attached document outranks the
  // same document inherited from a skill AND loses the inherited label.
  it('keeps only the first occurrence of a duplicated path', async () => {
    const planned = await planContextDocs(
      {
        links: links({ agent: ['specs/shared.md'], bySkill: { s1: ['specs/shared.md', 'docs/extra.md'] } }),
        agents: agents([{ skill: { id: 's1', name: 'Security', enabled: true } }]),
      },
      { workspaceId: WS, agentId: AGENT },
    );

    expect(planned).toEqual([
      { path: 'specs/shared.md' },
      { path: 'docs/extra.md', inheritedFrom: 'Security' },
    ]);
  });

  // Both switches gate inheritance, exactly as `buildSkillBlocks` gates bodies.
  it('excludes documents of a skill muted per-agent or disabled library-wide', async () => {
    const planned = await planContextDocs(
      {
        links: links({
          bySkill: { muted: ['docs/muted.md'], off: ['docs/off.md'], on: ['docs/on.md'] },
        }),
        agents: agents([
          { skill: { id: 'muted', name: 'Muted', enabled: true }, enabled: false },
          { skill: { id: 'off', name: 'Off', enabled: false }, enabled: true },
          { skill: { id: 'on', name: 'On', enabled: true }, enabled: true },
        ]),
      },
      { workspaceId: WS, agentId: AGENT },
    );

    expect(planned.map((p) => p.path)).toEqual(['docs/on.md']);
  });
});

describe('resolveContextForRun — reads, ceilings and degradation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'project-context-resolve-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(
    over: Partial<ResolverDeps> & { git?: ResolverDeps['git'] } = {},
    opts: { agent?: string[]; bySkill?: Record<string, string[]> } = {},
  ): ResolverDeps {
    return {
      links: links(opts),
      agents: agents(),
      git: gitFor(root),
      countTokens: (t) => Math.ceil(t.length / 4),
      ...over,
    };
  }

  // AC-39 + AC-40 — the arguments, not just the result: the resolver asks the
  // repository for THIS workspace's THIS agent, and reads each resolved path
  // from the clone through the port.
  it('reads every resolved document from the clone through GitClient.readFile', async () => {
    await write(root, 'specs/a.md', 'AAA');
    await write(root, 'docs/b.md', 'BBB');
    const readFile = vi.fn(async (_ref: { owner: string; name: string }, p: string) =>
      p === 'specs/a.md' ? 'AAA' : 'BBB',
    );
    const agentDocs = vi.fn(async () => [
      { path: 'specs/a.md', order: 0 },
      { path: 'docs/b.md', order: 1 },
    ]);

    const out = await resolveContextForRun(
      deps({
        links: { agentDocs, docsForSkills: async () => new Map() },
        git: gitFor(root, { readFile }),
      }),
      INPUT,
    );

    expect(agentDocs).toHaveBeenCalledWith(WS, AGENT);
    expect(readFile.mock.calls).toEqual([
      [{ owner: 'acme', name: 'payments-api' }, 'specs/a.md'],
      [{ owner: 'acme', name: 'payments-api' }, 'docs/b.md'],
    ]);
    expect(out.texts).toEqual(['AAA', 'BBB']);
    expect(out.injected).toEqual(['specs/a.md', 'docs/b.md']);
    expect(out.skipped).toEqual([]);
  });

  // AC-50 — an empty resolution is an empty list, not an error. Step 24 turns
  // this into an OMITTED `specs` key.
  it('returns an empty result when the agent attaches nothing', async () => {
    const out = await resolveContextForRun(deps(), INPUT);
    expect(out).toEqual({ texts: [], injected: [], skipped: [] });
  });

  // AC-43 — a document that cannot be read is skipped with reason `unread`, and
  // the rest of the list still reaches the prompt.
  it('records an unreadable document as unread and keeps going', async () => {
    await write(root, 'specs/present.md', 'HERE');
    const out = await resolveContextForRun(
      deps({}, { agent: ['specs/missing.md', 'specs/present.md'] }),
      INPUT,
    );

    expect(out.injected).toEqual(['specs/present.md']);
    expect(out.skipped).toEqual([{ path: 'specs/missing.md', reason: 'unread' }]);
  });

  // AC-43 again, from the other direction: a path that escapes the clone is
  // never read at all. The persisted row is filtered at the attach door, so
  // this is the belt behind that brace.
  it('never reads a persisted path that escapes the clone', async () => {
    const readFile = vi.fn(async () => 'SHOULD NOT HAPPEN');
    const out = await resolveContextForRun(
      deps({ git: gitFor(root, { readFile }) }, { agent: ['../../../etc/passwd'] }),
      INPUT,
    );

    expect(readFile).not.toHaveBeenCalled();
    expect(out.texts).toEqual([]);
    expect(out.skipped).toEqual([{ path: '../../../etc/passwd', reason: 'unread' }]);
  });

  // AC-49 — the size cap is checked by `lstat` BEFORE the read, so an oversize
  // document never occupies memory.
  it('marks a document over the byte cap as oversize without reading it', async () => {
    await write(root, 'specs/big.md', 'x'.repeat(2048));
    await write(root, 'specs/small.md', 'ok');
    const readFile = vi.fn(async (_ref: { owner: string; name: string }, p: string) =>
      p === 'specs/small.md' ? 'ok' : 'x'.repeat(2048),
    );

    const out = await resolveContextForRun(
      deps(
        { git: gitFor(root, { readFile }), limits: { maxBytes: 1024 } },
        { agent: ['specs/big.md', 'specs/small.md'] },
      ),
      INPUT,
    );

    expect(out.skipped).toEqual([{ path: 'specs/big.md', reason: 'oversize' }]);
    expect(out.injected).toEqual(['specs/small.md']);
    expect(readFile.mock.calls.map((c) => c[1])).toEqual(['specs/small.md']);
  });

  /**
   * AC-43 + AC-61/62, the time-of-check/time-of-use gap (Cut 2 review, F-11):
   * an attached path that SINCE resolves outside the clone is skipped, and the
   * host file's bytes are never read.
   *
   * TWO swaps, because they are two different vectors and the first one alone
   * is what let this ship insufficient once already:
   *
   *   1. the FILE becomes a symlink out of the clone;
   *   2. a DIRECTORY COMPONENT becomes a symlink out of the clone, the file
   *      itself untouched. `lstat` does not follow the final component but DOES
   *      follow every intermediate one, so this case reports
   *      `isSymbolicLink() === false`, stays lexically inside the clone, and
   *      reads the host file. Only `realpath` containment catches it — a test
   *      that swaps only the file passes against the broken version.
   *
   * The attach check cannot cover either: it ran when both paths were regular
   * files, and re-attaching is exempt from it. `SimpleGitClient.readFile`'s
   * guard is lexical, so both paths are "contained" as far as it can tell.
   *
   * The load-bearing assertion is the ABSENCE of the read: a version that read
   * the host file and then discarded it would satisfy the `skipped` expectation
   * on its own. `unread` (rather than a new reason) is what makes the Live Log
   * line and the trace's `specs_skipped` entry identical in shape to an
   * unreadable file — `run-executor.ts:483-485` groups by exactly that reason.
   */
  it('never reads an attached path that resolves outside the clone', async () => {
    const hostDir = await mkdtemp(join(tmpdir(), 'project-context-host-'));
    try {
      // The host side: a secret file, and a whole secret directory.
      const secretFile = join(hostDir, 'id_rsa');
      await writeFile(secretFile, 'HOST SECRET');
      const secretDir = join(hostDir, 'outside');
      await mkdir(secretDir, { recursive: true });
      await writeFile(join(secretDir, 'foo.md'), 'HOST DIR SECRET');

      await write(root, 'specs/ok.md', 'OK');
      // Vector 1 — the attached file itself is replaced by a link.
      await symlink(secretFile, join(root, 'specs/swapped-file.md'));
      // Vector 2 — `specs/sub/foo.md` was a real file at attach time; the
      // DIRECTORY is what gets replaced afterwards.
      await write(root, 'specs/sub/foo.md', 'legit');
      await rm(join(root, 'specs/sub'), { recursive: true, force: true });
      await symlink(secretDir, join(root, 'specs/sub'));

      const readFile = vi.fn(async (_ref: { owner: string; name: string }, p: string) =>
        readFileFs(join(root, p), 'utf8'),
      );

      const out = await resolveContextForRun(
        deps(
          { git: gitFor(root, { readFile }) },
          { agent: ['specs/swapped-file.md', 'specs/sub/foo.md', 'specs/ok.md'] },
        ),
        INPUT,
      );

      expect(readFile.mock.calls.map((c) => c[1])).toEqual(['specs/ok.md']);
      expect(out.skipped).toEqual([
        { path: 'specs/swapped-file.md', reason: 'unread' },
        { path: 'specs/sub/foo.md', reason: 'unread' },
      ]);
      expect(out.injected).toEqual(['specs/ok.md']);
      expect(out.texts).toEqual(['OK']);
      expect(out.texts.join('\n')).not.toContain('SECRET');
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  // A symlink that stays INSIDE the clone leaks nothing, but is still not a
  // document: the attach-time walk never emits one (`walk.ts:118`), so the
  // resolver agrees with it rather than injecting something the Context tab
  // could not have listed.
  it('skips a symlink that points back inside the clone', async () => {
    await write(root, 'specs/real.md', 'INSIDE');
    await symlink(join(root, 'specs/real.md'), join(root, 'specs/alias.md'));

    const out = await resolveContextForRun(
      deps({}, { agent: ['specs/alias.md', 'specs/real.md'] }),
      INPUT,
    );

    expect(out.skipped).toEqual([{ path: 'specs/alias.md', reason: 'unread' }]);
    expect(out.injected).toEqual(['specs/real.md']);
  });

  // AC-45 + NFR-2 — stop at the ceiling, and report EVERY remaining path as
  // `budget`, including the one that did not fit.
  it('stops at the token budget and records every remaining document', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await write(root, `specs/${name}.md`, name.repeat(400));

    const out = await resolveContextForRun(
      deps({ limits: { budgetTokens: 200 } }, { agent: ['specs/a.md', 'specs/b.md', 'specs/c.md', 'specs/d.md'] }),
      INPUT,
    );

    // 400 chars ≈ 100 tokens each, so two fit under 200 and the third does not.
    expect(out.injected).toEqual(['specs/a.md', 'specs/b.md']);
    expect(out.skipped).toEqual([
      { path: 'specs/c.md', reason: 'budget' },
      { path: 'specs/d.md', reason: 'budget' },
    ]);

    // NFR-2 — counted on what the resolver returns, which is the only place the
    // budget is enforced (a reviewer-core test can only assemble what it is given).
    const used = out.texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    expect(used).toBeLessThanOrEqual(200);
  });

  // The spec's edge case: a single document over budget on its own is excluded
  // and the run still happens.
  it('excludes a document that busts the budget on its own', async () => {
    await write(root, 'specs/huge.md', 'x'.repeat(PROJECT_CONTEXT_TOKEN_BUDGET * 4 + 400));
    const out = await resolveContextForRun(deps({}, { agent: ['specs/huge.md'] }), INPUT);

    expect(out.texts).toEqual([]);
    expect(out.skipped).toEqual([{ path: 'specs/huge.md', reason: 'budget' }]);
  });

  // AC-47 — a throwing lookup does not throw out of the resolver. The run
  // proceeds with no project context, and says so in the Live Log.
  it('degrades to no context when resolution throws, and never rejects', async () => {
    const onLog = vi.fn();
    const out = await resolveContextForRun(
      deps({ links: links({ throwOnAgentDocs: true }), onLog }),
      INPUT,
    );

    expect(out).toEqual({ texts: [], injected: [], skipped: [] });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('reviewing without it'));
  });

  // AC-48 — the timeout wraps the WHOLE pass and partial work is discarded, so
  // the prompt is either the full resolution or the no-context baseline.
  it('abandons a slow resolution and returns no context', async () => {
    await write(root, 'specs/slow.md', 'SLOW');
    const onLog = vi.fn();
    const out = await resolveContextForRun(
      deps(
        {
          git: gitFor(root, { readFile: () => new Promise<string>(() => {}) }),
          limits: { timeoutMs: 20 },
          onLog,
        },
        { agent: ['specs/slow.md'] },
      ),
      INPUT,
    );

    expect(out).toEqual({ texts: [], injected: [], skipped: [] });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('exceeded 20ms'));
  });

  // A tokenizer that throws must cost precision, never the run.
  it('falls back to a character estimate when the token counter throws', async () => {
    await write(root, 'specs/a.md', 'AAAA');
    const out = await resolveContextForRun(
      deps(
        {
          countTokens: () => {
            throw new Error('BPE ranks failed to load');
          },
        },
        { agent: ['specs/a.md'] },
      ),
      INPUT,
    );

    expect(out.injected).toEqual(['specs/a.md']);
  });

  /**
   * NFR-1 — p95 ≤ 250 ms over 20 runs of a 20-document fixture.
   *
   * Environment-dependent by nature (it is file I/O on whatever disk the suite
   * runs on), so the measurement is printed as well as asserted; a failure here
   * is a signal to look at the machine before looking at the code.
   */
  it('resolves 20 documents well inside the run-start latency budget', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const p = `specs/doc-${String(i).padStart(2, '0')}.md`;
      await write(root, p, 'lorem ipsum '.repeat(200));
      paths.push(p);
    }
    const d = deps({ limits: { budgetTokens: Number.MAX_SAFE_INTEGER } }, { agent: paths });

    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const t0 = performance.now();
      const out = await resolveContextForRun(d, INPUT);
      samples.push(performance.now() - t0);
      expect(out.injected).toHaveLength(20);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
    // eslint-disable-next-line no-console
    console.log(`NFR-1: resolver p95 over 20 runs of 20 documents = ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(250);
  });
});
