/* hooks/eval.ts — React Query hooks for SPEC-04 Agent Evals. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  EvalBatchAccepted,
  EvalBatchEstimate,
  EvalBatchRecord,
  EvalCase,
  EvalCaseInputBody,
  EvalDashboard,
  EvalWorkspaceDashboard,
} from "@devdigest/shared";
import { agentKeys, evalKeys } from "./keys";

/*
 * Every type above is an `import type`. A VALUE import from `@devdigest/shared`
 * breaks the webpack build while `pnpm typecheck` and `pnpm test` both stay
 * green (`client/insights.md` 2026-08-11), and this file imports six of them.
 *
 * Every path below is served — checked against the eval module's route table
 * (`server/src/modules/eval/routes.ts`), because two shipped hooks in this
 * folder already call endpoints the API has never had.
 */

// ---- cases -----------------------------------------------------------------

export function useEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.cases(agentId),
    queryFn: () => api.get<EvalCase[]>(`/agents/${agentId}/eval-cases`),
    enabled: !!agentId,
  });
}

export function useEvalCase(caseId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.case(caseId),
    queryFn: () => api.get<EvalCase>(`/eval-cases/${caseId}`),
    enabled: !!caseId,
  });
}

export function useCreateEvalCase(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvalCaseInputBody) =>
      api.post<EvalCase>(`/agents/${agentId}/eval-cases`, body),
    onSuccess: (data) => {
      // BOTH keys, explicitly: `eval-cases` and `eval-case` share no prefix.
      qc.invalidateQueries({ queryKey: evalKeys.cases(agentId) });
      qc.setQueryData(evalKeys.case(data.id), data);
    },
  });
}

export function useUpdateEvalCase(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, body }: { caseId: string; body: EvalCaseInputBody }) =>
      api.put<EvalCase>(`/eval-cases/${caseId}`, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: evalKeys.cases(agentId) });
      qc.setQueryData(evalKeys.case(data.id), data);
    },
  });
}

export function useDeleteEvalCase(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.del<{ ok: true }>(`/eval-cases/${caseId}`),
    onSuccess: (_d, caseId) => {
      qc.invalidateQueries({ queryKey: evalKeys.cases(agentId) });
      qc.removeQueries({ queryKey: evalKeys.case(caseId) });
      qc.invalidateQueries({ queryKey: evalKeys.batches(agentId) });
    },
  });
}

/** AC-5-AC-18 — turn a finding into a case. Body-less POST; see `api.ts:26`. */
export function useCreateEvalCaseFromFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) =>
      api.post<EvalCase>(`/findings/${findingId}/eval-case`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: evalKeys.cases(data.owner_id) });
      qc.invalidateQueries({ queryKey: evalKeys.workspace });
    },
  });
}

// ---- batches ---------------------------------------------------------------

/**
 * AC-61, AC-62, AC-66 — an agent's batches, newest first, POLLED while one is
 * running.
 *
 * The default query config is `staleTime: 30_000, refetchOnWindowFocus: false`
 * (`lib/providers.tsx:28-29`), so nothing else in the app will refresh this
 * screen: without the interval below the running state would stick until the
 * user navigated away and back.
 */
export function useEvalBatches(agentId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.batches(agentId),
    queryFn: () => api.get<EvalBatchRecord[]>(`/agents/${agentId}/eval-runs`),
    enabled: !!agentId,
    refetchInterval: (query) => {
      const data = query.state.data as EvalBatchRecord[] | undefined;
      return data?.some((b) => b.status === "running") ? 2_000 : false;
    },
    staleTime: 0,
  });
}

/** AC-27 — 202 and poll. The mutation returns a receipt, never a result. */
export function useRunAgentEvalBatch(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalBatchAccepted>(`/agents/${agentId}/eval-runs`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evalKeys.batches(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.workspace });
    },
  });
}

/** AC-116 / plan D-9 — a one-case batch. */
export function useRunEvalCase(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) =>
      api.post<EvalBatchAccepted>(`/eval-cases/${caseId}/runs`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evalKeys.batches(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
    },
  });
}

/** AC-42, AC-43 — run every enabled agent that has cases. */
export function useRunWorkspaceEval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalBatchAccepted[]>(`/eval/runs`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evalKeys.workspace });
      qc.invalidateQueries({ queryKey: evalKeys.estimate });
    },
  });
}

// ---- dashboards ------------------------------------------------------------

export function useEvalWorkspaceDashboard() {
  return useQuery({
    queryKey: evalKeys.workspace,
    queryFn: () => api.get<EvalWorkspaceDashboard>("/eval"),
    refetchInterval: (query) => {
      const data = query.state.data as EvalWorkspaceDashboard | undefined;
      return data?.batches.some((b) => b.status === "running") ? 2_000 : false;
    },
  });
}

export function useEvalAgentDashboard(agentId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.agent(agentId),
    queryFn: () => api.get<EvalDashboard>(`/eval/agents/${agentId}`),
    enabled: !!agentId,
  });
}

/**
 * AC-72 — what "Run all agents" would cost.
 *
 * `est_cost_usd` is `null` when no priced batch exists to extrapolate from.
 * That is not `$0.00`, and the call site must render it as unknown.
 */
export function useEvalEstimate(enabled = true) {
  return useQuery({
    queryKey: evalKeys.estimate,
    queryFn: () => api.get<EvalBatchEstimate>("/eval/estimate"),
    enabled,
  });
}

// ---- phase 2 ---------------------------------------------------------------

/** AC-102-AC-105 — restore an older agent version. Body-less POST. */
export function useRestoreAgentVersion(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api.post<{ id: string; version: number }>(
        `/agents/${agentId}/versions/${version}/restore`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentKeys.all });
      qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
    },
  });
}
