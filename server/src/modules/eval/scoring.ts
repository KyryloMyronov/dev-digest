import type { EvalExpectation, EvalExpectedFinding } from '@devdigest/shared';
import { PRECISION_ALERT_DELTA } from './constants.js';

/**
 * SPEC-04 — the scorer.
 *
 * PURE. No `this`, no I/O, no container, no LLM. That is not a stylistic
 * preference: AC-56 says every eval metric is computed WITHOUT a model call, and
 * a module that cannot reach a provider makes that structurally true rather than
 * merely tested. The verification is that the injected LLM port records zero
 * calls while a batch is scored.
 */

/** The citation-shaped part of an actual finding — all the scorer reads. */
export interface ActualFinding {
  file: string;
  start_line: number;
  end_line: number;
  /**
   * Present on a real `Finding`, and DELIBERATELY unread here. See
   * `isNoise`/`matchesRange`: AC-57 applies the range test to every actual
   * finding regardless of `kind`.
   */
  kind?: string | null;
}

/** One case's inputs to the scorer. */
export interface ScoredCaseInput {
  caseId: string;
  expectation: EvalExpectation;
  expected: readonly Pick<EvalExpectedFinding, 'file' | 'start_line' | 'end_line'>[];
  /** Findings that SURVIVED the engine's grounding gate. */
  actual: readonly ActualFinding[];
  /** How many candidates the engine dropped at that gate (AC-52's denominator). */
  droppedCount: number;
  /** True when the case never produced a result — a provider or parse failure. */
  errored?: boolean;
}

/** One case's score. */
export interface CaseScore {
  caseId: string;
  pass: boolean;
  expectedCount: number;
  actualCount: number;
  matchedCount: number;
  noiseCount: number;
  /** kept ÷ (kept + dropped); `null` when the engine produced no candidate. */
  citationAccuracy: number | null;
}

/** A whole batch's score. */
export interface BatchScore {
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  tracesPassed: number;
  tracesTotal: number;
  cases: CaseScore[];
}

/**
 * AC-44 — an actual finding matches an expected one when their files are equal
 * and their `[start_line, end_line]` ranges intersect.
 *
 * This deliberately MIRRORS `rangeIntersects` in
 * `reviewer-core/src/grounding.ts:68` (called at `:119`) rather than importing
 * it. Two reasons, both load-bearing:
 *
 *  1. `rangeIntersects` is off the `reviewer-core` barrel ON PURPOSE — the
 *     barrel comment says `groundCitations` is meant to be the whole seam — so
 *     exporting it would be a `reviewer-core` change, which SPEC-04's Non-goals
 *     forbid.
 *  2. `groundCitations` is the wrong predicate anyway: it builds a line index
 *     FROM A DIFF and asks "does this item touch a changed line". Matching an
 *     actual finding against an EXPECTED finding is a two-list range-overlap
 *     test with no diff in it.
 *
 * If `grounding.ts:68` ever changes shape, this comment is the thread back.
 */
export function matchesRange(
  actual: Pick<ActualFinding, 'file' | 'start_line' | 'end_line'>,
  expected: Pick<EvalExpectedFinding, 'file' | 'start_line' | 'end_line'>,
): boolean {
  if (actual.file !== expected.file) return false;
  const aLo = Math.min(actual.start_line, actual.end_line);
  const aHi = Math.max(actual.start_line, actual.end_line);
  const eLo = Math.min(expected.start_line, expected.end_line);
  const eHi = Math.max(expected.start_line, expected.end_line);
  return aLo <= eHi && eLo <= aHi;
}

/**
 * Score ONE case.
 *
 * Noise, in one rule (plan D-4, subsuming AC-47 and AC-49): on a
 * `must_not_flag` case EVERY actual finding is noise, whatever its
 * `expected_output` holds. On a `must_find` case an actual finding is noise
 * when it matches no expectation of that case (AC-48).
 *
 * Pass (AC-54, split by expectation — plan D-3):
 *  - `must_find`     every expectation matched AND no unmatched extra produced
 *  - `must_not_flag` no actual finding at all
 */
export function scoreCase(input: ScoredCaseInput): CaseScore {
  const expected = input.expectation === 'must_not_flag' ? [] : input.expected;
  const actual = input.actual;

  const matchedExpected = expected.filter((e) => actual.some((a) => matchesRange(a, e)));
  // AC-57 — the range test is applied to EVERY actual finding regardless of the
  // `kind` it carries. A model that labels a fabricated finding `secret_leak`
  // must not thereby exempt itself from scoring; `kind` is never read here.
  const unmatchedActual = actual.filter((a) => !expected.some((e) => matchesRange(a, e)));

  const noiseCount =
    input.expectation === 'must_not_flag' ? actual.length : unmatchedActual.length;

  const pass =
    input.expectation === 'must_not_flag'
      ? actual.length === 0
      : matchedExpected.length === expected.length && unmatchedActual.length === 0;

  // AC-52 / AC-53 — kept ÷ (kept + dropped) over the ENGINE's candidates, and
  // null when the engine produced no candidate at all (not 0: "no candidates"
  // and "every candidate dropped" are different facts).
  const candidates = actual.length + input.droppedCount;
  const citationAccuracy = candidates === 0 ? null : actual.length / candidates;

  return {
    caseId: input.caseId,
    pass,
    expectedCount: expected.length,
    actualCount: actual.length,
    matchedCount: matchedExpected.length,
    noiseCount,
    citationAccuracy,
  };
}

/**
 * Score a whole batch from its per-case inputs.
 *
 * Metric rules, in the order they resolve:
 *  - recall    = matched expected ÷ all expected across the batch's `must_find`
 *                cases; `null` when that denominator is 0 (AC-45, AC-46).
 *  - precision = 1 − noise ÷ all actual findings; `1` when the batch produced
 *                none (AC-50, AC-51).
 *  - citation  = the MICRO-average Σkept ÷ Σ(kept+dropped) over the cases that
 *                produced a candidate; `null` when none did (AC-52, plan D-6).
 *
 * AC-38 OUTRANKS AC-51 (plan D-15): a batch in which EVERY case errored
 * produced no finding because nothing ran, so all three metrics are `null`
 * rather than `precision = 1`.
 *
 * `cases` here are the cases that RAN. Cases the batch never reached are simply
 * absent, which is what leaves the batch deriving as `partial`.
 */
export function scoreBatch(inputs: readonly ScoredCaseInput[]): BatchScore {
  const scores = inputs.map(scoreCase);
  const everyCaseFailed = inputs.length > 0 && inputs.every((c) => c.errored === true);

  const ran = inputs.filter((c) => c.errored !== true);
  const ranScores = scores.filter((_, i) => inputs[i]!.errored !== true);

  const expectedTotal = ran.reduce(
    (n, c) => n + (c.expectation === 'must_not_flag' ? 0 : c.expected.length),
    0,
  );
  const matchedTotal = ranScores.reduce((n, s, i) => {
    const c = ran[i]!;
    return n + (c.expectation === 'must_not_flag' ? 0 : s.matchedCount);
  }, 0);

  const actualTotal = ranScores.reduce((n, s) => n + s.actualCount, 0);
  const noiseTotal = ranScores.reduce((n, s) => n + s.noiseCount, 0);

  const keptTotal = actualTotal;
  const droppedTotal = ran.reduce((n, c) => n + c.droppedCount, 0);
  const candidateTotal = keptTotal + droppedTotal;

  if (everyCaseFailed) {
    // AC-38 — nothing ran, so nothing is known. Not `precision = 1`.
    return {
      recall: null,
      precision: null,
      citationAccuracy: null,
      tracesPassed: 0,
      tracesTotal: inputs.length,
      cases: scores,
    };
  }

  return {
    recall: expectedTotal === 0 ? null : matchedTotal / expectedTotal,
    precision: actualTotal === 0 ? 1 : 1 - noiseTotal / actualTotal,
    citationAccuracy: candidateTotal === 0 ? null : keptTotal / candidateTotal,
    tracesPassed: ranScores.filter((s) => s.pass).length,
    tracesTotal: inputs.length,
    cases: scores,
  };
}

/** AC-74's structured alert. The English sentence is the STUDIO's (plan D-14). */
export interface MetricAlert {
  metric: 'precision';
  /** How far the metric fell, as a positive number. */
  delta: number;
}

/**
 * AC-74 — a precision drop of at least `PRECISION_ALERT_DELTA` against the
 * previous batch raises an alert.
 *
 * Returns the metric and the drop, never a sentence: with only a metric name and
 * a number crossing the wire the banner has nowhere to put a causal clause the
 * code cannot justify (spec D-31, UX-3). `null` on either side means there is
 * nothing to compare, not that nothing changed.
 */
export function alertFor(
  previous: { precision: number | null } | null | undefined,
  current: { precision: number | null } | null | undefined,
): MetricAlert | null {
  const prev = previous?.precision;
  const cur = current?.precision;
  if (typeof prev !== 'number' || typeof cur !== 'number') return null;
  const delta = prev - cur;
  if (delta < PRECISION_ALERT_DELTA) return null;
  return { metric: 'precision', delta };
}

/**
 * The server's convenience sentence. Asserted in `server-unit` and read by
 * NOTHING else — the studio composes its banner from `alert_metric` +
 * `alert_delta` through next-intl (plan D-14), so the English lives in the
 * catalogue rather than here.
 */
export function alertSentence(alert: MetricAlert | null): string | null {
  if (!alert) return null;
  return `${alert.metric} dropped by ${alert.delta.toFixed(4)} since the previous batch`;
}
