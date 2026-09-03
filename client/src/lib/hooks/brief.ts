/* hooks/brief.ts — SPEC-02, the derived PR brief (why / risks / review focus).
   Read the persisted brief for a PR, or queue a derivation.

   The POST is a job receipt (202), not a result: the derivation makes a model
   call server-side and lands on `pr_brief` when it finishes. So the mutation
   starts the work and the QUERY observes it, polling until the stored brief is
   fresh for the PR's current head — the same idiom `hooks/intent.ts` arrived
   at, and for the same reason. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { notify } from "../toast";
import type { PrBriefRecord } from "@devdigest/shared";
import { briefKeys } from "./keys";

/** How often to re-read while a derivation is in flight. */
const BRIEF_POLL_MS = 2000;

/** The 202 receipt. Deliberately not a shared contract — it never leaves here. */
export interface BriefDeriveAccepted {
  status: string;
  jobId?: string;
  degraded?: boolean;
  reason?: string;
}

/**
 * Is this record the brief of the commit the PR is on right now?
 *
 * Exported for the same reason `isFreshFor` is: the polling stop-condition and
 * the card's staleness badge (AC-36) MUST agree. Two copies of this comparison
 * eventually disagree and leave the card polling forever behind a badge that
 * says it is done.
 */
export function isBriefFreshFor(
  record: PrBriefRecord | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!record) return false;
  if (!headSha || !record.head_sha) return true;
  return record.head_sha === headSha;
}

/**
 * The PR's derived brief, or `null` when nothing has been derived yet (the
 * endpoint never derives on read — a GET must not spend a model call).
 *
 * Pass `pollUntilHead` while a derivation is expected: the query then re-reads
 * until the stored record is fresh for that head (AC-34). The stop condition is
 * the SERVER's own state, not a client flag, so a derivation started anywhere —
 * this tab, another tab, another actor — ends the polling.
 */
export function usePrBrief(
  prId: string | null | undefined,
  opts: { pollUntilHead?: string | null } = {},
) {
  const { pollUntilHead } = opts;
  return useQuery({
    queryKey: briefKeys.byPr(prId),
    queryFn: () => api.get<PrBriefRecord | null>(`/pulls/${prId}/brief`),
    enabled: !!prId,
    refetchInterval: (query) =>
      pollUntilHead && !isBriefFreshFor(query.state.data, pollUntilHead) ? BRIEF_POLL_MS : false,
  });
}

/**
 * Queue a derivation (the card's "Derive" / "Re-derive" control).
 *
 * Resolving means the job was ACCEPTED, not that a brief exists — the caller
 * watches `usePrBrief` for the result. A `degraded` receipt means no handler
 * took the job, which the caller must surface rather than spin on.
 */
export function useDeriveBrief(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<BriefDeriveAccepted>(`/pulls/${prId}/brief`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: briefKeys.byPr(prId) });
    },
    onError: (err: Error) => notify.error(err.message),
  });
}
