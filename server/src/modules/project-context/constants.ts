/**
 * project-context constants — SPEC-01.
 *
 * This file is the module's PUBLIC surface, together with `types.ts`
 * (`no-cross-module-internals` whitelists exactly those two), so every number an
 * AC or NFR names lives here and each one is a one-line edit.
 *
 * The module is called `project-context`, NOT `context`: `modules/_shared/context.ts`
 * (`getContext`, the tenancy resolver) and `db/schema/context.ts` (code chunks,
 * symbols, references) both already exist, and a third same-shaped name is how
 * the two `IndexStatus` declarations got confused.
 */

// --- Job kinds (registered on JobRunner) ------------------------------------
/**
 * Token-count scan for one repository. Enqueued on clone completion
 * (`repos/service.ts`) and by `POST /repos/:id/context/reindex` (AC-63).
 */
export const TOKEN_COUNT_JOB_KIND = 'project-context-token-count';

// --- Discovery --------------------------------------------------------------
/**
 * The configured directory roots. A `.md` file is a candidate iff some
 * directory segment of its clone-relative path is one of these, at ANY depth
 * (AC-1 / D-Q6a); the LEFTMOST match supplies the source tag (AC-2).
 *
 * `insights` matches nothing in *this* repository (there are zero directories
 * by that name — package-level insights are `insights.md` FILES). That is a
 * root matching nothing here, not a tag that can never match: a user repo with
 * an `insights/` directory is the case AC-1 was written for. Extending the
 * predicate to bare `insights.md` files would be authoring a requirement AC-1
 * does not contain — see the plan's OQ-A.
 */
export const CONTEXT_ROOTS = ['specs', 'docs', 'insights'] as const;

/** AC-6 — hard cap on the returned list; the overflow is reported, not swallowed. */
export const MAX_CONTEXT_DOCUMENTS = 500;

// --- Read-time limits -------------------------------------------------------
/**
 * NFR-5 / AC-49 — the largest document that may be read. Matches repo-intel's
 * `MAX_FILE_SIZE` so the two walks agree on what "too big" means. Note this is
 * a READ-time cap only: the walk deliberately does not filter by size, because
 * NFR-5 requires a 400 KB document to be listed and previewable.
 */
export const MAX_CONTEXT_DOCUMENT_BYTES = 400 * 1024;

/** AC-45 / NFR-2 — ceiling on the tokens a single run's project context may add. */
export const PROJECT_CONTEXT_TOKEN_BUDGET = 8000;

/** AC-48 — wall-clock ceiling on resolving + reading a run's documents. */
export const PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS = 5000;

/**
 * AC-38 — soft self-watch budget for the token-count job. Well under
 * `JobRunner`'s hard 120 s timeout, following `INDEX_SOFT_BUDGET_MS`'s posture:
 * finish early and persist what is done rather than being killed mid-write.
 */
export const TOKEN_JOB_BUDGET_MS = 110_000;
