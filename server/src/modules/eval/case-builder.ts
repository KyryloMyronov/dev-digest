import type { EvalExpectation, EvalExpectedFinding, UnifiedDiff } from '@devdigest/shared';
import { sliceDiff } from '@devdigest/reviewer-core';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';

/**
 * SPEC-04 — turning an accepted or dismissed finding into a frozen eval case
 * (AC-10, AC-13, AC-14, AC-15, AC-17).
 *
 * PURE. Rows in, values out; the service does every read and every write. That
 * is what makes AC-10 / AC-15 / AC-17 unit-testable with no Docker and no
 * container — the three criteria that would otherwise need a seeded database to
 * observe at all.
 */

/** The columns of `findings` this builder reads. Deliberately not the row type. */
export interface SourceFinding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  acceptedAt: Date | null;
  dismissedAt: Date | null;
}

/** The columns of `pull_requests` this builder reads. */
export interface SourcePull {
  id: string;
  number: number;
  title: string;
  headSha: string;
}

/** The columns of `pr_files` this builder reads. */
export interface SourcePrFile {
  path: string;
  patch: string | null;
}

export interface BuildCaseInput {
  finding: SourceFinding;
  pull: SourcePull;
  prFiles: readonly SourcePrFile[];
  /** Every existing case name owned by the same agent (AC-15's collision set). */
  existingNames: readonly string[];
}

/** What the service persists, field by named field (AC-114). */
export interface BuiltCase {
  name: string;
  inputDiff: string;
  expectation: EvalExpectation;
  expectedOutput: EvalExpectedFinding[];
  inputMeta: {
    head_sha: string;
    source_finding_ids: string[];
    task: string;
    pr_number: number;
    file: string;
  };
}

/**
 * AC-17 is a REFUSAL, not a throw: a pure function that raises cannot be
 * composed, and the 422 is the service's to decide. The discriminated result is
 * the seam between "this cannot be built" and "this must be rejected with a
 * status code".
 */
export type BuildCaseResult =
  | { ok: true; value: BuiltCase }
  | { ok: false; reason: 'file_not_in_diff' };

/**
 * Rebuild the PR's unified diff from its persisted `pr_files` patches.
 *
 * These five lines duplicate `diffFromPrFiles` (`modules/reviews/diff-loader.ts`)
 * ON PURPOSE, exactly as the spec says `buildSkillBlocks` is rebuilt rather than
 * moved. That function is another module's INTERNAL — importing it is
 * `no-cross-module-internals` — and its sibling `loadDiff` needs a `PullRow`
 * plus a `repos` row that an eval case does not have and never will, since a
 * case outlives the branch it was frozen from.
 */
function diffFromPrFiles(prFiles: readonly SourcePrFile[]): UnifiedDiff {
  const parts: string[] = [];
  for (const f of prFiles) {
    if (!f.patch) continue;
    parts.push(`diff --git a/${f.path} b/${f.path}`);
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    parts.push(f.patch);
  }
  return parseUnifiedDiff(parts.join('\n'));
}

/**
 * AC-14 — the case name is derived from the finding's title.
 *
 * A slug, not the raw title: the name is shown in a table, used in a breadcrumb
 * and disambiguated by suffix (AC-15), and a title carrying a slash, a quote or
 * RTL text makes all three worse. Empty input yields `eval-case` rather than an
 * empty string, because a nameless row is not addressable.
 */
export function deriveCaseName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'eval-case';
}

/**
 * AC-15 — the LOWEST UNUSED numeric suffix, not a counter.
 *
 * A counter would skip a number after a delete and then never reuse it; the
 * criterion says lowest unused, so this scans. `base` itself is suffix 1, and
 * the first collision therefore yields `base-2`.
 */
export function uniqueCaseName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * AC-7 / AC-8 / AC-9 — what this case asserts.
 *
 * `accepted_at` WINS when both timestamps are set (AC-9): a reviewer who
 * accepted a finding said it was real, and a later dismissal is more likely
 * housekeeping than a reversal of that judgement.
 */
export function expectationFor(finding: Pick<SourceFinding, 'acceptedAt' | 'dismissedAt'>): EvalExpectation {
  return finding.acceptedAt ? 'must_find' : 'must_not_flag';
}

export function buildCaseFromFinding(input: BuildCaseInput): BuildCaseResult {
  const { finding, pull, prFiles, existingNames } = input;

  const diff = diffFromPrFiles(prFiles);
  // AC-17 — the finding points at a file its own PR's diff does not contain.
  // Checked against the PARSED file list rather than against `sliceDiff`'s
  // return, because `sliceDiff` falls back to the whole diff for an unknown
  // path (`reviewer-core/src/review/reduce.ts:70-73`) and would silently freeze
  // every file of the PR into the case.
  if (!diff.files.some((f) => f.path === finding.file)) {
    return { ok: false, reason: 'file_not_in_diff' };
  }

  // AC-10 — the SINGLE-FILE fragment, frozen so the case still means something
  // once the branch is deleted.
  const inputDiff = sliceDiff(diff, finding.file);

  const expectation = expectationFor(finding);

  // AC-13 — one entry, carrying the finding's own file and range. `end_line` is
  // written explicitly rather than left to AC-21's transform: this value comes
  // from a column, not from a hand-authored body.
  const expectedOutput: EvalExpectedFinding[] = [
    {
      file: finding.file,
      start_line: finding.startLine,
      end_line: finding.endLine,
      severity: finding.severity as EvalExpectedFinding['severity'],
      category: finding.category as EvalExpectedFinding['category'],
      title: finding.title,
    },
  ];

  return {
    ok: true,
    value: {
      name: uniqueCaseName(deriveCaseName(finding.title), existingNames),
      inputDiff,
      expectation,
      expectedOutput,
      inputMeta: {
        // AC-11 — the head SHA of the pull request the finding came from.
        head_sha: pull.headSha,
        // AC-12 / AC-16 — the provenance that makes a second click idempotent.
        source_finding_ids: [finding.id],
        // AC-28's frozen task: the prompt this case replays is the PR's own.
        task: pull.title,
        pr_number: pull.number,
        file: finding.file,
      },
    },
  };
}
