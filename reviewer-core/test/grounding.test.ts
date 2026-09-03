import { describe, it, expect } from 'vitest';
import type { Finding, UnifiedDiff } from '@devdigest/shared';
import { groundCitations, groundFindings } from '../src/grounding.js';

/**
 * SPEC-02 AC-24–AC-27 — the citation-shaped gate.
 *
 * The diff is built as a literal rather than parsed: `parseUnifiedDiff` lives
 * in the server's git adapter and this package may not import from `server/src`
 * (`no-core-imports-from-server`). The server's own `test/grounding.test.ts`
 * keeps exercising the parsed path for `groundFindings`, unchanged.
 *
 * `src/config.ts` covers new-side lines 11–13; `src/api/users.ts` covers 44–49.
 * Neither hunk covers a DELETED (old-side) line — the parser accumulates
 * new-side numbers only, so an old-side citation is structurally unlinkable
 * end to end. That is a constraint, not a preference.
 */
const DIFF: UnifiedDiff = {
  raw: '',
  files: [
    {
      path: 'src/config.ts',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          file: 'src/config.ts',
          oldStart: 10,
          oldLines: 3,
          newStart: 11,
          newLines: 3,
          newLineNumbers: [11, 12, 13],
        },
      ],
    },
    {
      path: 'src/api/users.ts',
      additions: 4,
      deletions: 0,
      hunks: [
        {
          file: 'src/api/users.ts',
          oldStart: 44,
          oldLines: 2,
          newStart: 44,
          newLines: 6,
          newLineNumbers: [44, 45, 46, 47, 48, 49],
        },
      ],
    },
  ],
};

interface TestRisk {
  file: string;
  start_line: number;
  end_line: number;
  kind?: string;
  title?: string;
}

describe('groundCitations — SPEC-02', () => {
  it('AC-24 keeps a risk whose line range intersects a hunk of the same file', () => {
    const res = groundCitations<TestRisk>(
      [{ file: 'src/config.ts', start_line: 12, end_line: 12 }],
      DIFF,
    );
    expect(res.kept).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });

  it('AC-24 keeps a risk whose range spans several hunk lines', () => {
    const res = groundCitations<TestRisk>(
      [{ file: 'src/api/users.ts', start_line: 45, end_line: 52 }],
      DIFF,
    );
    expect(res.kept).toHaveLength(1);
  });

  it('AC-25 drops a risk naming a file absent from the diff, with the file reason', () => {
    const res = groundCitations<TestRisk>(
      [{ file: 'src/not-here.ts', start_line: 1, end_line: 1 }],
      DIFF,
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toBe("file 'src/not-here.ts' not present in diff");
  });

  it('AC-26 drops a risk whose range hits no hunk, with the lines reason', () => {
    const res = groundCitations<TestRisk>(
      [{ file: 'src/config.ts', start_line: 999, end_line: 999 }],
      DIFF,
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toBe(
      "lines 999-999 do not intersect any diff hunk in 'src/config.ts'",
    );
  });

  it('AC-26 drops a risk citing an OLD-SIDE (deleted) line — no new-side number covers it', () => {
    // The deleted line was old-side 10; the new side of this hunk starts at 11,
    // so nothing in the index can ever resolve it.
    const res = groundCitations<TestRisk>(
      [{ file: 'src/config.ts', start_line: 10, end_line: 10 }],
      DIFF,
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toMatch(/do not intersect/);
  });

  it('AC-26 / D-8 drops a risk claiming kind:"phantom" — a free-string kind exempts nothing', () => {
    // The regression net for D-8: FULL_FILE_KINDS is reachable ONLY through
    // groundFindings' own mapping, so a caller that carries a `kind` cannot
    // bypass line anchoring by naming one.
    const res = groundCitations<TestRisk>(
      [{ file: 'src/config.ts', start_line: 999, end_line: 999, kind: 'phantom' }],
      DIFF,
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toMatch(/do not intersect/);
  });

  it('AC-27 drops a focus entry naming a file absent from the diff, even with fullFile', () => {
    // The file-presence check runs BEFORE the exemption — that ordering is why
    // AC-25 and AC-26 are separate criteria.
    const res = groundCitations<TestRisk>(
      [{ file: 'docs/nope.md', start_line: 0, end_line: 0 }],
      DIFF,
      { fullFile: () => true },
    );
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toBe("file 'docs/nope.md' not present in diff");
  });

  it('AC-27 keeps a line-less focus entry whose file IS in the diff', () => {
    const res = groundCitations<TestRisk>(
      [{ file: 'src/config.ts', start_line: 0, end_line: 0 }],
      DIFF,
      { fullFile: () => true },
    );
    expect(res.kept).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });
});

describe('groundFindings — behaviour is unchanged by the generalisation', () => {
  function f(partial: Partial<Finding>): Finding {
    return {
      id: 'x',
      severity: 'WARNING',
      category: 'bug',
      title: 't',
      file: 'src/config.ts',
      start_line: 12,
      end_line: 12,
      rationale: 'r',
      confidence: 0.8,
      ...partial,
    };
  }

  it('still exempts a full-file kind from line anchoring', () => {
    const res = groundFindings([f({ start_line: 1, end_line: 1, kind: 'secret_leak' })], DIFF);
    expect(res.kept).toHaveLength(1);
  });

  it('still drops a full-file kind whose file is absent from the diff', () => {
    const res = groundFindings([f({ file: 'src/gone.ts', kind: 'secret_leak' })], DIFF);
    expect(res.kept).toHaveLength(0);
    expect(res.dropped[0]!.reason).toBe("file 'src/gone.ts' not present in diff");
  });

  it('still returns dropped entries keyed by `finding`, not `item`', () => {
    const res = groundFindings([f({ start_line: 999, end_line: 999 })], DIFF);
    expect(res.dropped[0]!.finding.title).toBe('t');
    expect(res.dropped[0]!.reason).toBe(
      "lines 999-999 do not intersect any diff hunk in 'src/config.ts'",
    );
  });
});
