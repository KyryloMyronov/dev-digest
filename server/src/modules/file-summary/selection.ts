import type { Container } from '../../platform/container.js';
import type * as schema from '../../db/schema.js';
import { wrapUntrusted } from '../../platform/prompt.js';
import { classifyPath } from '../_shared/classify-path.js';
import { FILE_SUMMARY_PROMPT_TOKEN_CAP } from './constants.js';

/**
 * SPEC-03 — which files a derivation summarises, in what order, how many of them
 * fit the token cap, and how one call's usage is apportioned across them.
 *
 * NFR-11: THIS FILE PRODUCES PROMPT TEXT AND MUST NOT LOG ANY OF IT. Names,
 * provenance and sizes only — never a patch, never a summary.
 *
 * AC-25: every patch goes through `wrapUntrusted`, which also neutralises an
 * attempt to close the fence from inside by rewriting `</untrusted>`. NO PATCH
 * TEXT REACHES THE MESSAGE UNFENCED, which is why the assembled message carries
 * exactly one fence per admitted file and the test counts them.
 */

/**
 * The `pr_files` row, referenced through the schema rather than through another
 * module's repository — `no-cross-module-internals` forbids importing
 * `PrFileRow` from `modules/pulls/repository.ts`, and `db/rows.ts` does not
 * carry it. `modules/brief/{pipeline,sources}.ts` alias `RepoRow` the same way.
 * Do NOT "fix" this into a cross-module import: `pnpm lint:arch` fails on it.
 */
export type PrFileRow = typeof schema.prFiles.$inferSelect;

/** What `selectFiles` needs of a file row — nothing else. */
type SelectableFile = Pick<PrFileRow, 'path' | 'additions' | 'deletions' | 'patch'>;

export interface SelectFilesArgs {
  /** AC-12 — summarise only this file. Absent ⇒ a PR-level derivation. */
  path?: string;
}

/**
 * The derivation-ELIGIBLE set — the read-path half of plan D-2, exported here so
 * the service and the pipeline cannot disagree about what "eligible" means:
 * a non-boilerplate file whose patch is not `null`.
 *
 * `total` in `PrFileSummariesResponse` is `eligibleFor(files).length`. A
 * boilerplate file is never in the denominator, because AC-18 means it is never
 * a candidate.
 */
export function eligibleFor<T extends SelectableFile>(files: T[]): T[] {
  return files.filter((f) => f.patch !== null && classifyPath(f.path) !== 'boilerplate');
}

/**
 * The selection, in the order tokens should be spent.
 *
 *   1. AC-22 — drop every file whose `patch` is `null` (binary, rename-only,
 *      mode-only, GitHub-truncated). Unqualified in the spec, so it applies to
 *      the per-file path too: a per-file request naming a null-patch file yields
 *      an EMPTY selection, which the pipeline exits as `no_files`.
 *   2. AC-12 — when `args.path` is set, the selection is that one file (after
 *      clause 1). AC-18's boilerplate exclusion DOES NOT APPLY here: AC-18 says
 *      "from a PR-LEVEL derivation's selection", and a reviewer who explicitly
 *      asks for a lock file's summary should get one.
 *   3. AC-18 — for a PR-level derivation, drop every `boilerplate` file, using
 *      the SAME `classifyPath` the tab groups by (`_shared/classify-path.ts`).
 *   4. AC-19 — `core` before `wiring`, then by `additions + deletions`
 *      DESCENDING, then `path.localeCompare` as a stable tie-break so the order
 *      is testable.
 *
 * AC-13/AC-19 VS THE SHIPPED RENDER ORDER — DO NOT "ALIGN" THEM.
 * `buildSmartDiff` sorts WITHIN a group by finding-lines first, then size
 * (`modules/pulls/smart-diff.ts`). That is the order to OPEN files in. AC-19 is
 * the order to SPEND TOKENS in. Two different concerns; the same note is on the
 * other side.
 */
export function selectFiles<T extends SelectableFile>(files: T[], args: SelectFilesArgs = {}): T[] {
  const withPatch = files.filter((f) => f.patch !== null);

  if (args.path !== undefined) {
    return withPatch.filter((f) => f.path === args.path);
  }

  /** `core` before `wiring`; `boilerplate` is already gone, and ranks last if a
   *  future rule ever lets one through. */
  const rank = (path: string): number => (classifyPath(path) === 'core' ? 0 : 1);
  return withPatch
    .filter((f) => classifyPath(f.path) !== 'boilerplate')
    .sort((a, b) => {
      const roleDelta = rank(a.path) - rank(b.path);
      if (roleDelta !== 0) return roleDelta;
      const sizeDelta = b.additions + b.deletions - (a.additions + a.deletions);
      if (sizeDelta !== 0) return sizeDelta;
      return a.path.localeCompare(b.path);
    });
}

/** One file that reached the prompt, with the tokens its block cost. */
export interface AdmittedFile {
  path: string;
  /** The block's token count — the WEIGHT vector `apportion` divides by. */
  tokens: number;
}

export interface AssembledFileSummaryPrompt {
  /** The user message: one trusted task line plus one fence per admitted file. */
  message: string;
  admitted: AdmittedFile[];
  /** Selected paths the cap left out, a contiguous tail in the same order. */
  omitted: string[];
}

/**
 * Assemble the user message under the token cap (AC-20, AC-21, AC-25, NFR-3).
 *
 * The budget is `FILE_SUMMARY_PROMPT_TOKEN_CAP` MINUS the tokenised system
 * prompt MINUS the tokenised task line: those are not optional, so they are
 * spent before any patch gets a look in. Files are then admitted in the AC-19
 * order while the running count stays inside the budget.
 *
 * Selection stops at the FIRST file that does not fit, and every file from there
 * on is recorded as omitted. That makes `omitted` a contiguous tail in the same
 * order — stable and testable — rather than a scattered set that depends on the
 * exact sizes of later files. A single file too large for the whole budget is
 * OMITTED, never half-sent: half a hunk describes something that is not there.
 *
 * The tokenizer is resolved from `container` and NEVER constructed: the BPE ranks
 * load once per process (`platform/container.ts` memoises with `??=`), and
 * `TiktokenTokenizer.count` already catches internally and falls back to a
 * character estimate rather than throwing.
 */
export function assembleFileSummaryPrompt(
  container: Container,
  args: {
    selection: SelectableFile[];
    systemPrompt: string;
    /** The trusted task line — names the PR, carries no untrusted text. */
    task: string;
  },
): AssembledFileSummaryPrompt {
  const { selection, systemPrompt, task } = args;
  const tokenizer = container.tokenizer;

  let budget =
    FILE_SUMMARY_PROMPT_TOKEN_CAP - tokenizer.count(systemPrompt) - tokenizer.count(task);

  const admitted: AdmittedFile[] = [];
  const blocks: string[] = [];
  const omitted: string[] = [];
  let capped = false;

  for (const file of selection) {
    if (capped) {
      omitted.push(file.path);
      continue;
    }
    const block = wrapUntrusted(`file:${file.path}`, file.patch ?? '');
    const cost = tokenizer.count(block);
    if (cost > budget) {
      capped = true;
      omitted.push(file.path);
      continue;
    }
    budget -= cost;
    admitted.push({ path: file.path, tokens: cost });
    blocks.push(block);
  }

  return { message: [task, ...blocks].join('\n\n'), admitted, omitted };
}

/**
 * Split ONE call's total across the files that call covered, in proportion to
 * each file's prompt tokens (plan D-1).
 *
 *   - `total === null` → every share `null`. AC-34's unpriced case, and it must
 *     NEVER become `0`.
 *   - `total === 0` → every share `0`. AC-34's genuinely-free case. NEVER
 *     COALESCE THE TWO (root `insights.md` 2026-08-02).
 *   - otherwise → proportional, with the REMAINDER assigned so that
 *     `sum(shares) === total` EXACTLY: to the largest weight for the integer
 *     case, and to the last share for the float case (see the comment on the
 *     float branch — IEEE-754 non-associativity makes the two different
 *     problems).
 *
 * A single-file selection receives the whole aggregate, which falls out of the
 * formula. Zero total weight (a degenerate empty-patch selection) splits evenly
 * for the same exactness reason.
 *
 * THE EXACTNESS IS A TEST, NOT A COMMENT: NFR-1 measures the SUM across a
 * derivation's rows and AC-59 renders the same sum, so a rounding leak is a
 * wrong dollar figure on screen.
 *
 * `integer: true` for `tokens_in` / `tokens_out`; float for `cost_usd`.
 */
export function apportion(
  total: number | null,
  weights: number[],
  opts: { integer?: boolean } = {},
): (number | null)[] {
  if (total === null) return weights.map(() => null);
  if (weights.length === 0) return [];
  if (total === 0) return weights.map(() => 0);

  const sumWeights = weights.reduce((n, w) => n + w, 0);
  const even = sumWeights === 0;
  const raw = (w: number): number => (even ? total / weights.length : (total * w) / sumWeights);

  if (opts.integer) {
    const shares = weights.map((w) => Math.floor(raw(w)));
    // The remainder (0 … n-1 whole tokens) goes to the LARGEST weight — first
    // one wins a tie. Integer arithmetic, so this is exact, full stop.
    let largest = 0;
    for (let i = 1; i < weights.length; i++) {
      if (weights[i]! > weights[largest]!) largest = i;
    }
    shares[largest] = shares[largest]! + (total - shares.reduce((n, s) => n + s, 0));
    return shares;
  }

  // FLOAT CASE — the correction lands on the LAST share, not on the largest
  // weight, and that difference is deliberate. IEEE-754 addition is not
  // associative, so adding a correction to a MIDDLE element re-rounds every
  // later partial sum and the naive left-to-right total does not converge on
  // `total` (measured: 0.0044 apportioned over 21 weights settles at
  // 0.004399999999999999 and stays there however many correction passes run).
  // Computing the final share as `total - <the same left-to-right running sum a
  // caller performs>` is exact by construction, and the discarded drift is
  // ~1e-18 of a dollar, so which row absorbs it is arithmetically irrelevant —
  // whereas the exactness is not: NFR-1 measures the SUM across a derivation's
  // rows and AC-59 renders it.
  const shares: number[] = [];
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    const share = i === weights.length - 1 ? total - acc : raw(weights[i]!);
    shares.push(share);
    acc += share;
  }
  return shares;
}
