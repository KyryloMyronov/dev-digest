/* hooks/intent.ts — L03, the derived PR intent.
   Read the persisted intent for a PR, or queue a re-derivation.

   The POST is a job receipt (202), not a result: the derivation makes a model
   call server-side and lands on `pr_intent` when it finishes. So the mutation
   starts the work and the QUERY observes it, polling until the stored intent is
   fresh for the PR's current head. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { notify } from "../toast";
import type { PrIntentRecord } from "@devdigest/shared";
import { intentKeys } from "./keys";

/** How often to re-read while a derivation is in flight. */
const INTENT_POLL_MS = 2000;

/** The 202 receipt. Deliberately not a shared contract — it never leaves here. */
export interface IntentDeriveAccepted {
  status: string;
  jobId?: string;
  degraded?: boolean;
  reason?: string;
}

/**
 * Is this record the intent of the commit the PR is on right now?
 *
 * Exported because the polling stop-condition and the card's "Stale" badge must
 * agree; two copies of this comparison would eventually disagree and leave the
 * card polling forever behind a badge that says it is done.
 */
export function isFreshFor(
  record: PrIntentRecord | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!record) return false;
  if (!headSha || !record.head_sha) return true;
  return record.head_sha === headSha;
}

/**
 * The PR's derived intent, or `null` when nothing has been derived yet (the
 * endpoint never derives on read — a review run or a queued job fills it).
 *
 * Pass `pollUntilHead` while a derivation is expected: the query then re-reads
 * until the stored record is fresh for that head. The stop condition is the
 * SERVER's own state, not a client flag, so a derivation started anywhere —
 * this tab, another tab, or a review run — ends the polling.
 */
export function usePrIntent(
  prId: string | null | undefined,
  opts: { pollUntilHead?: string | null } = {},
) {
  const { pollUntilHead } = opts;
  return useQuery({
    queryKey: intentKeys.byPr(prId),
    queryFn: () => api.get<PrIntentRecord | null>(`/pulls/${prId}/intent`),
    enabled: !!prId,
    refetchInterval: (query) =>
      pollUntilHead && !isFreshFor(query.state.data, pollUntilHead) ? INTENT_POLL_MS : false,
  });
}

/**
 * Queue a re-derivation (the "Derive"/"Re-derive" button).
 *
 * Resolving means the job was ACCEPTED, not that an intent exists — the caller
 * watches `usePrIntent` for the result. A `degraded` receipt means no handler
 * took the job, which the caller must surface rather than spin on.
 */
export function useDeriveIntent(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<IntentDeriveAccepted>(`/pulls/${prId}/intent`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: intentKeys.byPr(prId) });
    },
    onError: (err: Error) => notify.error(err.message),
  });
}
