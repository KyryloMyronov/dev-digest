/**
 * L03 · Smart Diff — the pure classifier (hermetic; no DB, no network, no LLM).
 *
 * What's worth pinning down here is the reasoning the feature rests on, not the
 * table of extensions: generated output wins over every other rule (a
 * `dist/index.js` is boilerplate, never wiring), only each agent's CURRENT
 * review contributes highlighted lines, `too_big` ignores boilerplate so a
 * lock-file bump can't fake a large PR, the split suggestion cuts at the
 * shallowest depth that actually separates the files, and a dismissed finding
 * contributes no highlighted line (enforced one layer down, in the repository).
 */
import { describe, it, expect } from 'vitest';
import {
  buildSmartDiff,
  classifyPath,
  findingLinesByPath,
  latestReviewPerAgent,
  proposeSplits,
  type ReviewedFinding,
} from '../src/modules/pulls/smart-diff.js';
import {
  SMART_DIFF_MAX_LINES_PER_FINDING,
  SMART_DIFF_MAX_SPLITS,
  SMART_DIFF_TOO_BIG_LINES,
} from '../src/modules/pulls/constants.js';

const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });

describe('classifyPath', () => {
  it('calls business logic core', () => {
    for (const p of [
      'server/src/modules/pulls/service.ts',
      'client/src/components/diff-viewer/FileCard/FileCard.tsx',
      'reviewer-core/src/engine.ts',
      'server/test/pulls-helpers.test.ts',
      'scripts/dev.sh',
    ]) {
      expect(classifyPath(p), p).toBe('core');
    }
  });

  it('calls configs, barrels and prose wiring', () => {
    for (const p of [
      'server/package.json',
      'server/tsconfig.json',
      'server/vitest.config.ts',
      'client/next.config.mjs',
      'server/src/modules/index.ts',
      'server/.env.example',
      '.github/workflows/contracts.yml',
      'docker-compose.yml',
      'README.md',
      'client/.eslintrc.json',
    ]) {
      expect(classifyPath(p), p).toBe('wiring');
    }
  });

  it('calls lock files, build output and snapshots boilerplate', () => {
    for (const p of [
      'server/pnpm-lock.yaml',
      'e2e/package-lock.json',
      'go.sum',
      'server/dist/app.js',
      'client/.next/static/chunk.js',
      'coverage/index.html',
      'client/src/test/__snapshots__/smoke.test.tsx.snap',
      'server/src/db/migrations/0007_add_pr_intent.sql',
      'server/dist/app.js.map',
    ]) {
      expect(classifyPath(p), p).toBe('boilerplate');
    }
  });

  it('decides generated-ness before wiring-ness', () => {
    // Both rules match `dist/index.ts`; the generated one has to win, or build
    // output shows up in the group a reviewer is told to skim.
    expect(classifyPath('server/dist/index.ts')).toBe('boilerplate');
    expect(classifyPath('server/src/modules/index.ts')).toBe('wiring');
  });
});

describe('latestReviewPerAgent', () => {
  const at = (iso: string) => new Date(iso);
  const f = (over: Partial<ReviewedFinding>): ReviewedFinding => ({
    reviewId: 'r1',
    agentId: 'general',
    reviewedAt: at('2026-08-18T12:00:00Z'),
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    ...over,
  });

  it("drops an agent's superseded review", () => {
    const kept = latestReviewPerAgent([
      f({ reviewId: 'r1', reviewedAt: at('2026-08-18T12:00:00Z'), startLine: 10, endLine: 10 }),
      f({ reviewId: 'r2', reviewedAt: at('2026-08-18T13:00:00Z'), startLine: 20, endLine: 20 }),
    ]);
    expect(kept.map((k) => k.startLine)).toEqual([20]);
  });

  it('keeps every agent when one run fans out to several reviews', () => {
    // `POST /pulls/:id/review {all:true}` writes these within milliseconds of
    // each other; the newest ROW alone would keep one agent and drop the rest.
    const kept = latestReviewPerAgent([
      f({ reviewId: 'r1', agentId: 'general', startLine: 10, endLine: 10 }),
      f({ reviewId: 'r2', agentId: 'security', startLine: 20, endLine: 20 }),
    ]);
    expect(kept.map((k) => k.startLine).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it("keeps an agent's only pass even when another agent reviewed later", () => {
    const kept = latestReviewPerAgent([
      f({ reviewId: 'r1', agentId: 'general', reviewedAt: at('2026-08-18T09:00:00Z'), startLine: 10, endLine: 10 }),
      f({ reviewId: 'r2', agentId: 'security', reviewedAt: at('2026-08-18T13:00:00Z'), startLine: 20, endLine: 20 }),
    ]);
    expect(kept.map((k) => k.startLine).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('treats agent-less reviews as one bucket', () => {
    const kept = latestReviewPerAgent([
      f({ reviewId: 'r1', agentId: null, reviewedAt: at('2026-08-18T12:00:00Z'), startLine: 10, endLine: 10 }),
      f({ reviewId: 'r2', agentId: null, reviewedAt: at('2026-08-18T13:00:00Z'), startLine: 20, endLine: 20 }),
    ]);
    expect(kept.map((k) => k.startLine)).toEqual([20]);
  });

  it('breaks a timestamp tie the same way whatever the row order', () => {
    const rows = [
      f({ reviewId: 'rA', startLine: 10, endLine: 10 }),
      f({ reviewId: 'rB', startLine: 20, endLine: 20 }),
    ];
    expect(latestReviewPerAgent(rows).map((k) => k.startLine)).toEqual([20]);
    expect(latestReviewPerAgent([...rows].reverse()).map((k) => k.startLine)).toEqual([20]);
  });

  it('keeps every finding of the review it keeps', () => {
    const kept = latestReviewPerAgent([
      f({ reviewId: 'r2', startLine: 20, endLine: 20 }),
      f({ reviewId: 'r2', startLine: 30, endLine: 30 }),
      f({ reviewId: 'r1', reviewedAt: at('2026-08-18T09:00:00Z'), startLine: 10, endLine: 10 }),
    ]);
    expect(kept.map((k) => k.startLine).sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it('is empty for a PR with no findings', () => {
    expect(latestReviewPerAgent([])).toEqual([]);
  });
});

describe('findingLinesByPath', () => {
  it('expands a range to every line it covers', () => {
    const lines = findingLinesByPath([{ file: 'a.ts', startLine: 10, endLine: 13 }]);
    expect(lines.get('a.ts')).toEqual([10, 11, 12, 13]);
  });

  it('merges overlapping findings and normalises a leading ./', () => {
    const lines = findingLinesByPath([
      { file: './src/a.ts', startLine: 5, endLine: 6 },
      { file: 'src/a.ts', startLine: 6, endLine: 7 },
    ]);
    expect(lines.get('src/a.ts')).toEqual([5, 6, 7]);
    expect([...lines.keys()]).toEqual(['src/a.ts']);
  });

  it('caps a runaway range instead of painting the whole file', () => {
    const lines = findingLinesByPath([{ file: 'a.ts', startLine: 1, endLine: 5000 }]);
    expect(lines.get('a.ts')).toHaveLength(SMART_DIFF_MAX_LINES_PER_FINDING);
  });
});

describe('buildSmartDiff', () => {
  it('groups core → wiring → boilerplate and omits empty roles', () => {
    const d = buildSmartDiff(
      [file('server/pnpm-lock.yaml', 900), file('server/src/a.ts', 10), file('README.md', 2)],
      [],
    );
    expect(d.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(buildSmartDiff([file('server/src/a.ts')], []).groups.map((g) => g.role)).toEqual([
      'core',
    ]);
  });

  it('attaches finding lines to the file they belong to', () => {
    const d = buildSmartDiff(
      [file('server/src/a.ts', 40), file('server/src/b.ts', 40)],
      [
        { file: 'server/src/a.ts', startLine: 28, endLine: 28 },
        { file: 'server/src/a.ts', startLine: 52, endLine: 52 },
      ],
    );
    const core = d.groups.find((g) => g.role === 'core')!;
    expect(core.files.find((f) => f.path === 'server/src/a.ts')!.finding_lines).toEqual([28, 52]);
    expect(core.files.find((f) => f.path === 'server/src/b.ts')!.finding_lines).toEqual([]);
  });

  it('orders the files with findings first, then by size', () => {
    const d = buildSmartDiff(
      [file('server/src/small.ts', 3), file('server/src/big.ts', 300), file('server/src/mid.ts', 30)],
      [{ file: 'server/src/small.ts', startLine: 1, endLine: 1 }],
    );
    expect(d.groups[0]!.files.map((f) => f.path)).toEqual([
      'server/src/small.ts',
      'server/src/big.ts',
      'server/src/mid.ts',
    ]);
  });

  it('does not call a lock-file bump a large PR, but still counts its lines', () => {
    const d = buildSmartDiff(
      [file('server/pnpm-lock.yaml', 6000), file('server/src/a.ts', 12)],
      [],
    );
    expect(d.split_suggestion.too_big).toBe(false);
    expect(d.split_suggestion.proposed_splits).toEqual([]);
    // `total_lines` stays the honest total — it is what the banner reports.
    expect(d.split_suggestion.total_lines).toBe(6012);
  });

  it('flags a genuinely large PR and proposes splits by area', () => {
    const d = buildSmartDiff(
      [
        file('server/src/modules/a.ts', SMART_DIFF_TOO_BIG_LINES),
        file('client/src/app/b.tsx', 50),
      ],
      [],
    );
    expect(d.split_suggestion.too_big).toBe(true);
    expect(d.split_suggestion.proposed_splits.map((s) => s.name)).toEqual(['server', 'client']);
  });

  it('proposes nothing when every file sits in one area', () => {
    const files = Array.from({ length: 4 }, (_, i) =>
      file(`server/src/modules/pulls/f${i}.ts`, 200),
    );
    const d = buildSmartDiff(files, []);
    expect(d.split_suggestion.too_big).toBe(true);
    // Depths 1–4 all yield a single area: there is no honest cut to suggest.
    expect(d.split_suggestion.proposed_splits).toEqual([]);
  });

  it('flags many small core files even when the line count is modest', () => {
    const files = Array.from({ length: 11 }, (_, i) => file(`pkg${i}/src/f.ts`, 2));
    expect(buildSmartDiff(files, []).split_suggestion.too_big).toBe(true);
  });
});

describe('proposeSplits', () => {
  it('cuts at the shallowest depth that separates the files', () => {
    const splits = proposeSplits(
      ['server/src/modules/a.ts', 'server/src/db/b.ts'],
      () => 1,
    );
    // Depth 1 and 2 lump both under `server` / `server/src`; depth 3 separates.
    expect(splits.map((s) => s.name).sort()).toEqual(['server/src/db', 'server/src/modules']);
  });

  it('merges the tail rather than dropping files past the cap', () => {
    const paths = Array.from({ length: SMART_DIFF_MAX_SPLITS + 3 }, (_, i) => `pkg${i}/f.ts`);
    const splits = proposeSplits(paths, () => 1);
    expect(splits).toHaveLength(SMART_DIFF_MAX_SPLITS);
    expect(splits.at(-1)!.name).toBe('everything else');
    expect(splits.flatMap((s) => s.files).sort()).toEqual([...paths].sort());
  });
});
