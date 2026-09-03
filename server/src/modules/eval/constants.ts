/**
 * SPEC-04 — the eval module's PUBLIC surface, half one.
 *
 * `constants.ts` and `types.ts` are the only two files another module or the
 * container may import from here — `no-cross-module-internals` allows exactly
 * `^src/modules/[^/]+/(constants|types)\.ts$` and nothing else
 * (`.dependency-cruiser.cjs:116-133`). Everything else in this folder is
 * private to it.
 */

/** JobRunner kind for one eval batch (manual, single-case, or workspace-wide). */
export const EVAL_BATCH_JOB_KIND = 'eval-batch';

/**
 * JobRunner kind for the auto-eval a version bump triggers (AC-85, phase 2).
 *
 * Published here because it is the CROSS-MODULE seam: `agents` bumps a version
 * and this module runs the batch, with no import between them — the same shape
 * `repos/service.ts` uses for `INDEX_JOB_KIND`.
 */
export const AGENT_VERSION_EVAL_JOB_KIND = 'agent-version-eval';

/**
 * Headroom the eval job kinds get on top of `EVAL_BATCH_MAX_MS` (AC-110 /
 * NFR-6) when they register with the JobRunner.
 *
 * The runner's default deadline is 120 s, and a batch runs its cases SERIALLY:
 * one case on a slow model is already a minute, so a seven-case batch was going
 * `failed` in `jobs` two minutes in while it kept running for six more. The
 * batch's own wall clock is the spec's limit, so the job's deadline is derived
 * from it — plus this margin, because `runBatch` checks the clock only BETWEEN
 * cases and the case in flight at the deadline still finishes (one LLM call is
 * bounded at 60 s × three attempts by the adapters).
 */
export const EVAL_JOB_TIMEOUT_HEADROOM_MS = 300_000;

/** AC-107 — an agent may hold at most this many eval cases. */
export const MAX_CASES_PER_AGENT = 50;

/** AC-106 / NFR-5 — a case's frozen `input_diff` may not exceed 256 KB. */
export const MAX_INPUT_DIFF_BYTES = 262_144;

/**
 * AC-109 / NFR-7 — an expected-output array may hold at most 20 entries.
 * The contract carries the same literal (`knowledge.ts`, `eval-ci.ts`); it is
 * duplicated rather than imported because a VALUE import from
 * `@devdigest/shared` breaks the client's webpack build.
 */
export const MAX_EXPECTED_FINDINGS = 20;

/** AC-108 / AC-71 — `/eval` returns at most this many batches, newest first. */
export const MAX_BATCHES_RETURNED = 50;

/**
 * AC-74 — a precision drop of at least this much against the previous batch
 * raises the regression alert. The threshold is stated, not inferred: the
 * studio composes the sentence from `alert_metric` + `alert_delta` (plan D-14).
 */
export const PRECISION_ALERT_DELTA = 0.02;
