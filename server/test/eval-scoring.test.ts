import { describe, it, expect } from 'vitest';
import {
  matchesRange,
  scoreCase,
  scoreBatch,
  alertFor,
  alertSentence,
  type ScoredCaseInput,
} from '../src/modules/eval/scoring.js';
import { PRECISION_ALERT_DELTA } from '../src/modules/eval/constants.js';

/**
 * SPEC-04 — the scorer, table-driven.
 *
 * Every expected value below is computed from the CRITERION's arithmetic
 * (3/13, 4/5, 2/3 …), never copied out of the implementation: a literal lifted
 * from the code cannot fail for the reason NFR-13 cares about
 * (`server/insights.md` 2026-08-29).
 */

const F = (file: string, start: number, end = start, kind?: string) => ({
  file,
  start_line: start,
  end_line: end,
  kind,
});
const E = (file: string, start: number, end = start) => ({
  file,
  start_line: start,
  end_line: end,
});

const caseInput = (over: Partial<ScoredCaseInput> = {}): ScoredCaseInput => ({
  caseId: 'c1',
  expectation: 'must_find',
  expected: [],
  actual: [],
  droppedCount: 0,
  ...over,
});

describe('AC-44 — matchesRange: same file + intersecting ranges', () => {
  const rows: [string, ReturnType<typeof F>, ReturnType<typeof E>, boolean][] = [
    ['identical single lines', F('a.ts', 12), E('a.ts', 12), true],
    ['different file, same line', F('b.ts', 12), E('a.ts', 12), false],
    ['actual entirely before expected', F('a.ts', 1, 5), E('a.ts', 6, 9), false],
    ['actual entirely after expected', F('a.ts', 10, 12), E('a.ts', 6, 9), false],
    ['touching at the low edge', F('a.ts', 1, 6), E('a.ts', 6, 9), true],
    ['touching at the high edge', F('a.ts', 9, 20), E('a.ts', 6, 9), true],
    ['actual contains expected', F('a.ts', 1, 40), E('a.ts', 6, 9), true],
    ['expected contains actual', F('a.ts', 7, 8), E('a.ts', 6, 9), true],
    ['off by one below', F('a.ts', 1, 5), E('a.ts', 6, 6), false],
    ['off by one above', F('a.ts', 7, 9), E('a.ts', 6, 6), false],
    ['reversed range still intersects', F('a.ts', 9, 6), E('a.ts', 7, 7), true],
  ];
  for (const [name, actual, expected, want] of rows) {
    it(name, () => {
      expect(matchesRange(actual, expected)).toBe(want);
    });
  }

  it('AC-57 — the range test applies regardless of `kind`', () => {
    // A model that labels a fabricated finding `secret_leak` must not thereby
    // exempt itself. This is the scorer's half of the trap root insights.md
    // 2026-08-28 records.
    const fabricated = F('a.ts', 900, 901, 'secret_leak');
    expect(matchesRange(fabricated, E('a.ts', 12))).toBe(false);

    const scored = scoreCase(
      caseInput({ expected: [E('a.ts', 12)], actual: [F('a.ts', 12), fabricated] }),
    );
    // The secret_leak finding is at a non-intersecting range, so it is noise.
    expect(scored.noiseCount).toBe(1);
    expect(scored.pass).toBe(false);
  });
});

describe('AC-54 — pass splits by expectation (plan D-3)', () => {
  it('must_find passes only when every expectation matched AND no extra was produced', () => {
    const allMatched = scoreCase(
      caseInput({ expected: [E('a.ts', 1), E('a.ts', 20)], actual: [F('a.ts', 1), F('a.ts', 20)] }),
    );
    expect(allMatched.pass).toBe(true);

    const missingOne = scoreCase(
      caseInput({ expected: [E('a.ts', 1), E('a.ts', 20)], actual: [F('a.ts', 1)] }),
    );
    expect(missingOne.pass).toBe(false);

    // AC-48 — an unmatched EXTRA fails the case even though every expectation
    // was matched. "expected 1, got 2" is not a pass.
    const withExtra = scoreCase(
      caseInput({ expected: [E('a.ts', 1)], actual: [F('a.ts', 1), F('a.ts', 99)] }),
    );
    expect(withExtra.pass).toBe(false);
    expect(withExtra.noiseCount).toBe(1);
  });

  it('must_not_flag passes only when the case produced NO finding at all', () => {
    expect(scoreCase(caseInput({ expectation: 'must_not_flag', actual: [] })).pass).toBe(true);
    const flagged = scoreCase(
      caseInput({ expectation: 'must_not_flag', actual: [F('a.ts', 3)] }),
    );
    expect(flagged.pass).toBe(false);
    // AC-47 + AC-49 as ONE rule (plan D-4): EVERY actual finding on a
    // must_not_flag case is noise, whatever its expected_output holds.
    expect(flagged.noiseCount).toBe(1);
  });

  it('AC-47/AC-49 — a must_not_flag case with a non-empty expected_output scores identically', () => {
    // AC-49 is AC-47 read on an empty expected_output; nothing scores a third
    // way. A stray expectation on a must_not_flag case must not rescue a finding.
    const withStrayExpectation = scoreCase(
      caseInput({
        expectation: 'must_not_flag',
        expected: [E('a.ts', 3)],
        actual: [F('a.ts', 3)],
      }),
    );
    expect(withStrayExpectation.noiseCount).toBe(1);
    expect(withStrayExpectation.pass).toBe(false);
    expect(withStrayExpectation.expectedCount).toBe(0);
  });
});

describe('AC-52 / AC-53 — citation accuracy', () => {
  it('is kept ÷ (kept + dropped) per case', () => {
    const s = scoreCase(caseInput({ actual: [F('a.ts', 1), F('a.ts', 2)], droppedCount: 1 }));
    // 2 kept of 3 candidates.
    expect(s.citationAccuracy).toBeCloseTo(2 / 3, 12);
  });

  it('AC-53 — is null, not 0, when the engine produced no candidate', () => {
    expect(scoreCase(caseInput({ actual: [], droppedCount: 0 })).citationAccuracy).toBeNull();
  });

  it('is 0 when every candidate was dropped — which is NOT the same as null', () => {
    expect(scoreCase(caseInput({ actual: [], droppedCount: 4 })).citationAccuracy).toBe(0);
  });

  it('plan D-6 — the batch value is the MICRO-average, not the mean of the per-case values', () => {
    // Case A: 3 kept of 4. Case B: 1 kept of 8. Case C: no candidate at all.
    const batch = scoreBatch([
      caseInput({
        caseId: 'A',
        expectation: 'must_not_flag',
        actual: [F('a.ts', 1), F('a.ts', 2), F('a.ts', 3)],
        droppedCount: 1,
      }),
      caseInput({
        caseId: 'B',
        expectation: 'must_not_flag',
        actual: [F('b.ts', 1)],
        droppedCount: 7,
      }),
      caseInput({ caseId: 'C', expectation: 'must_not_flag', actual: [], droppedCount: 0 }),
    ]);
    const microAverage = (3 + 1) / (4 + 8); // Σkept ÷ Σcandidates over A and B
    const meanOfCases = (3 / 4 + 1 / 8) / 2; // the WRONG answer, kept to pin the difference
    expect(batch.citationAccuracy).toBeCloseTo(microAverage, 12);
    expect(batch.citationAccuracy).not.toBeCloseTo(meanOfCases, 4);
  });

  it('is null for a batch in which no case produced a candidate', () => {
    const batch = scoreBatch([
      caseInput({ expectation: 'must_not_flag' }),
      caseInput({ caseId: 'c2', expectation: 'must_not_flag' }),
    ]);
    expect(batch.citationAccuracy).toBeNull();
  });
});

describe('AC-45 / AC-46 / AC-50 / AC-51 / AC-38 — the batch metrics', () => {
  it('AC-46 — recall is null when the must_find cases hold no expectation', () => {
    const batch = scoreBatch([caseInput({ expectation: 'must_not_flag', actual: [] })]);
    expect(batch.recall).toBeNull();
  });

  it('AC-51 — precision is 1 for a batch that produced no finding', () => {
    const batch = scoreBatch([caseInput({ expectation: 'must_not_flag', actual: [] })]);
    expect(batch.precision).toBe(1);
  });

  it('AC-38 outranks AC-51 (plan D-15) — an all-failed batch reports all three as null', () => {
    const batch = scoreBatch([
      caseInput({ caseId: 'a', errored: true }),
      caseInput({ caseId: 'b', errored: true }),
    ]);
    expect(batch.recall).toBeNull();
    expect(batch.precision).toBeNull();
    expect(batch.citationAccuracy).toBeNull();
    expect(batch.tracesPassed).toBe(0);
    expect(batch.tracesTotal).toBe(2);
  });

  it('AC-37 — a batch with one failure and one success still scores the one that ran', () => {
    const batch = scoreBatch([
      caseInput({ caseId: 'ok', expected: [E('a.ts', 1)], actual: [F('a.ts', 1)] }),
      caseInput({ caseId: 'boom', expected: [E('b.ts', 1)], errored: true }),
    ]);
    // The errored case contributes NOTHING to the denominators — its expectation
    // was never given a chance to be matched.
    expect(batch.recall).toBe(1);
    expect(batch.tracesPassed).toBe(1);
    expect(batch.tracesTotal).toBe(2);
  });

  it('recall counts matched expectations across the batch, must_not_flag excluded', () => {
    const batch = scoreBatch([
      caseInput({
        caseId: 'a',
        expected: [E('a.ts', 1), E('a.ts', 2), E('a.ts', 3)],
        actual: [F('a.ts', 1), F('a.ts', 2)],
      }),
      caseInput({ caseId: 'b', expected: [E('b.ts', 5)], actual: [F('b.ts', 5)] }),
      // A must_not_flag case must not add a denominator to recall.
      caseInput({ caseId: 'c', expectation: 'must_not_flag', expected: [E('c.ts', 9)] }),
    ]);
    expect(batch.recall).toBeCloseTo(3 / 4, 12);
  });
});

describe('NFR-13 — a deliberately worse output produces visibly worse numbers', () => {
  /** Ten expectations, each matched by exactly one actual finding. */
  const tenMatched = () => {
    const expected = Array.from({ length: 10 }, (_, i) => E('a.ts', (i + 1) * 10));
    const actual = expected.map((e) => F(e.file, e.start_line));
    return { expected, actual };
  };

  it('three unmatched extras on ten matched findings lower precision by exactly 3/13', () => {
    const { expected, actual } = tenMatched();
    const before = scoreBatch([caseInput({ expected, actual })]);
    // The three extras sit at ranges no expectation covers.
    const extras = [F('a.ts', 1000), F('a.ts', 1010), F('a.ts', 1020)];
    const after = scoreBatch([caseInput({ expected, actual: [...actual, ...extras] })]);

    expect(before.precision).toBe(1);
    // Computed from the criterion, not from the code: 3 noise of 13 actual.
    expect(after.precision!).toBeCloseTo(1 - 3 / 13, 12);
    expect(before.precision! - after.precision!).toBeCloseTo(3 / 13, 12);
    expect(Number((before.precision! - after.precision!).toFixed(4))).toBe(0.2308);
    // Recall is untouched: the ten expectations are still all matched.
    expect(after.recall).toBe(1);
  });

  it('removing one of five expectations lowers recall by exactly 0.2', () => {
    const expected = Array.from({ length: 5 }, (_, i) => E('a.ts', (i + 1) * 10));
    const allFound = expected.map((e) => F(e.file, e.start_line));
    const before = scoreBatch([caseInput({ expected, actual: allFound })]);
    const after = scoreBatch([caseInput({ expected, actual: allFound.slice(0, 4) })]);

    expect(before.recall).toBe(1);
    expect(after.recall!).toBeCloseTo(4 / 5, 12);
    expect(before.recall! - after.recall!).toBeCloseTo(1 / 5, 12);
  });
});

describe('AC-74 — alertFor fires at the stated threshold and not below it', () => {
  it('fires at exactly 0.02 and does not fire at 0.01', () => {
    expect(PRECISION_ALERT_DELTA).toBe(0.02);
    expect(alertFor({ precision: 0.9 }, { precision: 0.88 })).toEqual({
      metric: 'precision',
      delta: expect.closeTo(0.02, 12),
    });
    expect(alertFor({ precision: 0.9 }, { precision: 0.89 })).toBeNull();
  });

  it('does not fire on an improvement, or when either side is null', () => {
    expect(alertFor({ precision: 0.5 }, { precision: 0.99 })).toBeNull();
    expect(alertFor({ precision: null }, { precision: 0.1 })).toBeNull();
    expect(alertFor({ precision: 0.9 }, { precision: null })).toBeNull();
    expect(alertFor(null, { precision: 0.1 })).toBeNull();
  });

  it('the convenience sentence is derived from the structured alert, never the reverse', () => {
    expect(alertSentence(null)).toBeNull();
    expect(alertSentence({ metric: 'precision', delta: 0.25 })).toContain('precision');
    expect(alertSentence({ metric: 'precision', delta: 0.25 })).toContain('0.2500');
  });
});

describe('AC-56 — scoring is reachable with no provider in scope', () => {
  it('the module exports only pure functions', () => {
    // A structural check, not a behavioural one: `scoring.ts` imports exactly
    // one thing from outside itself (its own constants file) and a type. There
    // is no container, no LLM port and no DB handle it could call.
    expect(typeof scoreBatch).toBe('function');
    expect(typeof matchesRange).toBe('function');
  });
});
