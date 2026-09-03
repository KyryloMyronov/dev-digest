/* hooks/file-summary.ts — SPEC-03, the PR's derived per-file summaries.
   Read the persisted summaries for a PR, or queue a derivation.

   The POST is a job receipt (202), not a result: the derivation makes ONE model
   call server-side and lands N rows on `pr_file_summaries` when it finishes. So
   the mutation starts the work and the QUERY observes it, polling until the
   stored records are fresh for the PR's current head — the same idiom
   `hooks/intent.ts` arrived at and `hooks/brief.ts` copied, and for the same
   reason. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { notify } from "../toast";
import type { PrFileSummariesResponse, PrFileSummary } from "@devdigest/shared";
import { fileSummaryKeys } from "./keys";

/** NFR-6 / AC-56 — how often to re-read while a derivation is expected. */
export const FILE_SUMMARY_POLL_MS = 2000;
/** NFR-6 / AC-57 — give up waiting after this, and return the control to idle. */
export const DERIVE_TIMEOUT_MS = 90000;

/** The 202 receipt. Deliberately not a shared contract — it never leaves here. */
export interface FileSummaryDeriveAccepted {
  status: string;
  jobId?: string;
  degraded?: boolean;
  reason?: string;
}

/** What the POST body may carry (AC-12 / AC-17). */
export interface DeriveFileSummaryVars {
  /** Derive only this file. Absent ⇒ a PR-level derivation. */
  path?: string;
  /** Ignore the stored row for the requested files and re-derive. */
  force?: boolean;
}

/**
 * The one summary for a path, or undefined.
 *
 * The response carries AT MOST ONE row per path — the server projects the
 * accumulated per-head-SHA rows down to the current head's row, else the newest
 * stale one (SPEC-03 plan D-2). So this is a `find`, not a "pick the best".
 */
export function summaryFor(
  data: PrFileSummariesResponse | null | undefined,
  path: string,
): PrFileSummary | undefined {
  return data?.summaries.find((s) => s.path === path);
}

/**
 * Does this summary describe the commit the PR is on right now?
 *
 * Exported for the same reason `isFreshFor` / `isBriefFreshFor` are: the
 * per-file polling stop-condition and AC-58's staleness badge MUST agree. Two
 * copies of this comparison eventually disagree and leave the tab polling
 * forever behind a badge that says it is done.
 *
 * Unlike its two siblings there is no "no head recorded ⇒ treat as fresh" case:
 * `head_sha` is part of the row's primary key server-side, so it can never be
 * absent.
 */
export function isSummaryFreshFor(
  summary: PrFileSummary | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!summary) return false;
  if (!headSha) return true;
  return summary.head_sha === headSha;
}

/**
 * The PR's derived file summaries plus the AC-60 counts. The endpoint never
 * derives on read — a GET must not spend a model call (AC-7).
 *
 * Pass `pollWhile` while a derivation is expected. The stop condition is the
 * SERVER's own state, not a client flag, so a derivation started anywhere —
 * this tab, another tab, another actor — ends the polling.
 *
 * THE TWO STOP CONDITIONS DIFFER, and the difference is what makes AC-64 true
 * rather than accidental (the caller owns them; see `DiffTab`):
 *   - a PER-FILE wait stops when that path's summary is fresh for the head;
 *   - the PR-LEVEL wait stops when `selected === total`, so a single per-file
 *     summary landing bumps `selected` by one WITHOUT satisfying it, and the
 *     PR-level wait continues while the landed summary renders.
 * Corollary, stated honestly: on a token-capped PR `selected < total` forever,
 * so the PR-level wait ends at AC-57's 90 s. That is the NORMAL exit for a
 * capped PR, not a failure — the summaries that did land are already rendered.
 */
export function usePrFileSummaries(
  prId: string | null | undefined,
  opts: { pollWhile?: boolean } = {},
) {
  const { pollWhile } = opts;
  return useQuery({
    queryKey: fileSummaryKeys.byPr(prId),
    queryFn: () => api.get<PrFileSummariesResponse>(`/pulls/${prId}/file-summaries`),
    enabled: !!prId,
    refetchInterval: pollWhile ? FILE_SUMMARY_POLL_MS : false,
  });
}

/**
 * Queue a derivation — the PR-level control, or one file's (AC-12).
 *
 * Resolving means the job was ACCEPTED, not that a summary exists — the caller
 * watches `usePrFileSummaries` for the result. A `degraded` receipt means no
 * handler took the job, which the caller must surface rather than spin on.
 *
 * The body is sent only when it carries something: `api.post` omits an undefined
 * body, and `apiFetch` then omits the JSON content-type — which is what keeps a
 * PR-level derivation a legal body-less POST (client `insights.md` 2026-07-30).
 */
export function useDeriveFileSummaries(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: DeriveFileSummaryVars = {}) =>
      api.post<FileSummaryDeriveAccepted>(
        `/pulls/${prId}/file-summaries`,
        vars.path === undefined && vars.force === undefined ? undefined : vars,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: fileSummaryKeys.byPr(prId) });
    },
    onError: (err: Error) => notify.error(err.message),
  });
}
