/* hooks/conventions.ts — the Conventions screen's data layer.
 *
 * ONE query drives the whole screen. `GET /repos/:id/conventions` returns
 * `{ scan, items }` together, so the list, the "detected from N files" subtitle
 * and the "Scanning…" button all read from the same cache entry — and a scan
 * finishing refreshes the list in the same round trip that observes it, with no
 * cross-query invalidation to get wrong.
 *
 * Accept/reject/edit SEED the cache from the mutation's response rather than
 * invalidating: a refetch round trip would leave the old button fill and the old
 * "N of M accepted" counter on screen for a frame, which reads as a dropped click.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ConventionCandidate,
  ConventionSkillDraft,
  ConventionStatus,
  ConventionsView,
} from "@devdigest/shared";
import { conventionKeys, skillKeys } from "./keys";

/** How often to re-read while a scan is in flight. */
const SCAN_POLL_MS = 2000;

/** Statuses that mean "a scan is still going" — the only time we poll. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "running"]);

export function useConventions(repoId: string | null | undefined) {
  return useQuery({
    queryKey: conventionKeys.byRepo(repoId),
    queryFn: () => api.get<ConventionsView>(`/repos/${repoId}/conventions`),
    enabled: !!repoId,
    // A predicate rather than a boolean flag: the stop condition is the server's
    // own terminal status, so nothing in the page has to remember that a scan
    // was started in order to stop polling for it.
    refetchInterval: (query) =>
      IN_FLIGHT.has(query.state.data?.scan.status ?? "") ? SCAN_POLL_MS : false,
  });
}

/** Kick off a scan. The 202 carries no result — the scan row is the progress. */
export function useStartConventionScan(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ status: string; jobId?: string }>(`/repos/${repoId}/conventions/scan`),
    // Invalidate, never remove: the accepted/rejected rows already on screen
    // survive a re-scan, and dropping the entry would blank the list instead.
    onSuccess: () => qc.invalidateQueries({ queryKey: conventionKeys.byRepo(repoId) }),
  });
}

export interface UpdateConventionVars {
  id: string;
  patch: {
    status?: ConventionStatus;
    rule?: string;
    evidence_snippet?: string;
  };
}

export function useUpdateConvention(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateConventionVars) =>
      api.patch<ConventionCandidate>(`/repos/${repoId}/conventions/${id}`, patch),
    onSuccess: (updated) => seedOne(qc, repoId, updated),
  });
}

/**
 * Set many statuses in one request — what "Deselect all" is.
 *
 * Deliberately not N parallel PATCHes: every mutation error raises its own toast
 * (`lib/providers.tsx`), so a partial failure of N requests would stack N alerts.
 */
export function useSetConventionStatuses(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ids: string[]; status: ConventionStatus }) =>
      api.post<ConventionCandidate[]>(`/repos/${repoId}/conventions/status`, vars),
    onSuccess: (rows) => {
      for (const row of rows) seedOne(qc, repoId, row);
    },
  });
}

/**
 * The composed-but-unsaved skill over every accepted convention.
 *
 * Mounted only while the modal is open, so nothing is composed until asked for.
 * 422 when nothing is accepted — expected, and left to the modal to render
 * inline (queries only auto-toast on network/5xx).
 */
export function useConventionSkillDraft(repoId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: conventionKeys.skillDraft(repoId),
    queryFn: () => api.get<ConventionSkillDraft>(`/repos/${repoId}/conventions/skill-draft`),
    enabled: !!repoId && enabled,
    // The draft is derived from rows the user just edited; a cached one would be
    // wrong the moment they accept one more.
    staleTime: 0,
  });
}

/** Replace one item inside the `{ scan, items }` entry, leaving the scan alone. */
function seedOne(
  qc: ReturnType<typeof useQueryClient>,
  repoId: string,
  updated: ConventionCandidate,
) {
  qc.setQueryData<ConventionsView>(conventionKeys.byRepo(repoId), (prev) =>
    prev
      ? { ...prev, items: prev.items.map((c) => (c.id === updated.id ? updated : c)) }
      : prev,
  );
  // The draft is composed from the accepted set, so any status change stales it.
  qc.invalidateQueries({ queryKey: conventionKeys.skillDraft(repoId) });
  // A skill saved from this screen lands in the library.
  qc.invalidateQueries({ queryKey: skillKeys.all });
}
