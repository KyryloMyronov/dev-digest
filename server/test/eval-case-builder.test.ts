import { describe, it, expect } from 'vitest';
import {
  buildCaseFromFinding,
  deriveCaseName,
  expectationFor,
  uniqueCaseName,
  type BuildCaseInput,
  type SourceFinding,
} from '../src/modules/eval/case-builder.js';

/**
 * SPEC-04 step 11 — the case builder: AC-10, AC-13, AC-14, AC-15, AC-17
 * (and AC-7 / AC-8 / AC-9 through `expectationFor`).
 *
 * Hermetic by construction: the builder is pure, so none of this needs Docker,
 * a container or a seeded row.
 */

const PATCH_A = ['@@ -1,3 +1,4 @@', ' const a = 1;', '+const key = "sk_live_x";', ' const b = 2;'].join(
  '\n',
);
const PATCH_B = ['@@ -10,2 +10,3 @@', ' function f() {', '+  return null;', ' }'].join('\n');

const FINDING = (over: Partial<SourceFinding> = {}): SourceFinding => ({
  id: 'f-1',
  file: 'src/pay.ts',
  startLine: 2,
  endLine: 2,
  severity: 'critical',
  category: 'security',
  title: 'Hardcoded Stripe key',
  acceptedAt: new Date('2026-09-01T00:00:00Z'),
  dismissedAt: null,
  ...over,
});

const INPUT = (over: Partial<BuildCaseInput> = {}): BuildCaseInput => ({
  finding: FINDING(),
  pull: { id: 'p-1', number: 42, title: 'Add checkout', headSha: 'abc123' },
  prFiles: [
    { path: 'src/pay.ts', patch: PATCH_A },
    { path: 'src/other.ts', patch: PATCH_B },
  ],
  existingNames: [],
  ...over,
});

describe('AC-14 / AC-15 — the derived name and its suffix', () => {
  it('AC-14 — derives a slug from the finding title', () => {
    expect(deriveCaseName('Hardcoded Stripe key')).toBe('hardcoded-stripe-key');
  });

  it('AC-14 — a title of only punctuation still yields an addressable name', () => {
    expect(deriveCaseName('¿?!')).toBe('eval-case');
  });

  it('AC-15 — two findings on one file produce `name` and `name-2`', () => {
    const base = 'hardcoded-stripe-key';
    expect(uniqueCaseName(base, [])).toBe(base);
    expect(uniqueCaseName(base, [base])).toBe(`${base}-2`);
  });

  it('AC-15 — the LOWEST unused suffix, not a counter: a gap is reused', () => {
    // -2 was deleted; a counter would hand out -4, the criterion says -2.
    const base = 'dupe';
    expect(uniqueCaseName(base, ['dupe', 'dupe-3'])).toBe('dupe-2');
  });

  it('AC-15 — the built case takes the deduplicated name', () => {
    const r = buildCaseFromFinding(INPUT({ existingNames: ['hardcoded-stripe-key'] }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.name).toBe('hardcoded-stripe-key-2');
  });
});

describe('AC-7 / AC-8 / AC-9 — the expectation follows the reviewer judgement', () => {
  it('AC-7 — accepted becomes must_find', () => {
    expect(expectationFor({ acceptedAt: new Date(), dismissedAt: null })).toBe('must_find');
  });

  it('AC-8 — dismissed and never accepted becomes must_not_flag', () => {
    expect(expectationFor({ acceptedAt: null, dismissedAt: new Date() })).toBe('must_not_flag');
  });

  it('AC-9 — both timestamps set: accepted_at wins', () => {
    expect(expectationFor({ acceptedAt: new Date(), dismissedAt: new Date() })).toBe('must_find');
  });
});

describe('AC-10 / AC-11 / AC-12 / AC-13 — what gets frozen onto the row', () => {
  it('AC-10 — input_diff is the SINGLE-FILE fragment, not the whole PR diff', () => {
    const r = buildCaseFromFinding(INPUT());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.inputDiff).toContain('b/src/pay.ts');
    expect(r.value.inputDiff).toContain('sk_live_x');
    // The other file of the same PR must NOT be frozen into this case.
    expect(r.value.inputDiff).not.toContain('src/other.ts');
    expect(r.value.inputDiff).not.toContain('return null;');
  });

  it('AC-11 / AC-12 — head_sha and the source finding id land in input_meta', () => {
    const r = buildCaseFromFinding(INPUT());
    expect(r.ok && r.value.inputMeta.head_sha).toBe('abc123');
    expect(r.ok && r.value.inputMeta.source_finding_ids).toEqual(['f-1']);
  });

  it('AC-13 — expected_output holds one entry with the finding own file and range', () => {
    const r = buildCaseFromFinding(
      INPUT({ finding: FINDING({ startLine: 7, endLine: 9 }) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expectedOutput).toHaveLength(1);
    expect(r.value.expectedOutput[0]).toMatchObject({
      file: 'src/pay.ts',
      start_line: 7,
      end_line: 9,
    });
  });
});

describe('AC-17 — a finding whose file is absent from its PR diff', () => {
  it('returns a typed refusal rather than throwing', () => {
    const r = buildCaseFromFinding(
      INPUT({ finding: FINDING({ file: 'src/never-touched.ts' }) }),
    );
    expect(r).toEqual({ ok: false, reason: 'file_not_in_diff' });
  });

  it('refuses rather than silently freezing the WHOLE diff', () => {
    // sliceDiff falls back to the entire diff for an unknown path
    // (reviewer-core/src/review/reduce.ts:70-73). If the guard were removed the
    // case would still build — and would carry every file of the PR.
    const r = buildCaseFromFinding(
      INPUT({ finding: FINDING({ file: 'src/never-touched.ts' }) }),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses when the PR persisted no patch at all', () => {
    const r = buildCaseFromFinding(INPUT({ prFiles: [{ path: 'src/pay.ts', patch: null }] }));
    expect(r).toEqual({ ok: false, reason: 'file_not_in_diff' });
  });
});
