/* hooks/project-context.ts — React Query hooks for the Project Context domain.

     GET  /repos/:id/context            → ContextDocList
     GET  /repos/:id/context/doc?path=… → ContextDocContent
     POST /repos/:id/context/reindex    → IndexStatus (202, enqueues the scan)
     …plus the agent/skill attachment families, at the bottom of this file.

   `useContextFiles` and `useReindexContext` MOVED here out of `core.ts`, which
   had claimed project context as one of its domains. `client/AGENTS.md` asks for
   one hook file per domain, and project context is now a domain. Both are
   re-exported from `hooks/index.ts`, so no consumer's import path changes.

   `useContextFiles`'s generic is RETYPED from `SpecFile[]` to `ContextDocList`
   (SPEC-01 D-Q1). That is a different shape, not a widened one — an envelope
   cannot be an array — and it is safe because the endpoint has never been
   served: the hook 404'd on every branch until this build. `SpecFile` itself is
   untouched and its type-only consumers keep compiling. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AgentContextDoc,
  ContextDocContent,
  ContextDocList,
  IndexStatus,
  SkillContextDoc,
} from "../types";
import { contextKeys } from "./keys";

/**
 * The repository's discovered Markdown documents, with token and attachment
 * counts. A repo that has not finished cloning answers `409 repo_not_cloned`,
 * which reaches the caller as an `ApiError` the view branches on by status —
 * that is a distinct UI state (AC-5), not a load failure.
 */
export function useContextFiles(repoId: string | null | undefined) {
  return useQuery({
    queryKey: contextKeys.byRepo(repoId),
    queryFn: () => api.get<ContextDocList>(`/repos/${repoId}/context`),
    enabled: !!repoId,
  });
}

/**
 * One document's rendered-Markdown source.
 *
 * A SEPARATE query from the list, gated on `enabled`, which is what lets the
 * preview fail on its own (AC-12) while the list stays interactive. Its key
 * carries the path, so switching documents is a cache hit rather than a refetch
 * of the wrong body.
 */
export function useContextDoc(repoId: string | null | undefined, path: string | null | undefined) {
  return useQuery({
    queryKey: contextKeys.doc(repoId, path),
    queryFn: () =>
      api.get<ContextDocContent>(
        `/repos/${repoId}/context/doc?path=${encodeURIComponent(path ?? "")}`,
      ),
    enabled: !!repoId && !!path,
  });
}

/**
 * Re-run the token-count scan. Responds 202 with the job enqueued, so the fresh
 * counts arrive on a later refetch rather than in this response.
 *
 * The list key is invalidated EXPLICITLY, by name. `contextKeys.byRepo` and
 * `contextKeys.doc` do not share a prefix (`["context", id]` vs
 * `["context-doc", id, path]`), so a prefix sweep would refresh neither — and
 * the failure is silent: `staleTime: 30_000` with `refetchOnWindowFocus: false`
 * keeps the stale render on screen with no type or runtime error. Only the list
 * carries token counts, so only the list needs invalidating here.
 */
export function useReindexContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => api.post<IndexStatus>(`/repos/${repoId}/context/reindex`),
    onSuccess: (_d, repoId) => {
      qc.invalidateQueries({ queryKey: contextKeys.byRepo(repoId) });
    },
  });
}

// ---- Attachments (SPEC-01 Cut 2) -------------------------------------------
//
//   GET    /agents/:id/context-docs?repo_id=… → AgentContextDoc[]
//   POST   /agents/:id/context-docs           → attach one path
//   PUT    /agents/:id/context-docs           → reorder (the full ordered list)
//   DELETE /agents/:id/context-docs?path=…    → detach one path
//   GET/POST/DELETE /skills/:id/context-docs  → the skill equivalents
//
// Every mutation returns the owner's full, re-ordered list, so the cache is
// SEEDED from the response (`setQueryData`) rather than invalidated — a reorder
// that refetched would flash the old order between the drop and the response.
// This is `useLinkMutation`'s pattern in `hooks/skills.ts`, for the same reason.
//
// The repo list is invalidated as well, BY NAME: `contextKeys.byRepo` and
// `contextKeys.agentDocs` share no prefix (`["context", id]` vs
// `["agent-context-docs", …]`), so a prefix sweep would refresh neither, and
// `attached_agents` (AC-15) would keep rendering the pre-attach number with no
// type or runtime error to show for it.

/**
 * Coerce an attachment response to an ARRAY, always.
 *
 * The server's `response:` schema guarantees an array on the happy path, but the
 * client must not take the engine's word for it: a proxy error page, a mocked
 * `fetch` in a neighbouring test, or a future envelope change all yield
 * something that is truthy and not iterable, and `rows.map(...)` then throws
 * during render and takes the whole screen down with it — the agent editor and
 * the skill modal both mount these lists inside a larger surface.
 *
 * Degrade to "no attachments", the same posture the server-side resolver takes
 * for the same class of failure. `?? []` cannot do this: the value is truthy.
 */
function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The agent's ordered attachments, each with its discovered document inlined.
 *
 * `repoId` decides which repository the paths are resolved against — the tab
 * takes it from `useActiveRepo()` (D-Q6f). A row whose path is not discovered in
 * that repository comes back with `doc: null`, which is AC-29's unresolved row:
 * it must be shown and be removable, never dropped.
 */
export function useAgentContextDocs(
  agentId: string | null | undefined,
  repoId: string | null | undefined,
) {
  return useQuery({
    queryKey: contextKeys.agentDocs(agentId, repoId),
    queryFn: async () =>
      asRows<AgentContextDoc>(
        await api.get<AgentContextDoc[]>(
          `/agents/${agentId}/context-docs${repoId ? `?repo_id=${repoId}` : ""}`,
        ),
      ),
    enabled: !!agentId,
  });
}

/** The skill's ordered attachments. No inheritance — a skill is where it starts. */
export function useSkillContextDocs(
  skillId: string | null | undefined,
  repoId: string | null | undefined,
) {
  return useQuery({
    queryKey: contextKeys.skillDocs(skillId, repoId),
    queryFn: async () =>
      asRows<SkillContextDoc>(
        await api.get<SkillContextDoc[]>(
          `/skills/${skillId}/context-docs${repoId ? `?repo_id=${repoId}` : ""}`,
        ),
      ),
    enabled: !!skillId,
  });
}

/**
 * Shared mutation wiring for one owner's attachment list.
 *
 * `onMutate`/`onError` are the AC-26 rollback: the row flips optimistically and
 * a rejected request restores the exact previous list, so the UI never keeps a
 * state the server refused. Copied from `useUpdateAgent`/`useDeleteAgent`'s
 * shape, extended with the snapshot those two do not need.
 */
function useAttachmentMutation<TVars, TRow>(
  key: readonly unknown[],
  repoId: string | null | undefined,
  fn: (vars: TVars) => Promise<TRow[]>,
  optimistic?: (current: TRow[] | undefined, vars: TVars) => TRow[] | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (vars: TVars) => {
      if (!optimistic) return { previous: undefined };
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TRow[]>(key);
      const next = optimistic(previous, vars);
      if (next) qc.setQueryData(key, next);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // AC-26 — put the previous list back. The error itself surfaces through
      // the mutation's own `error`, which the row renders.
      if (ctx && "previous" in ctx) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: (rows) => {
      // Normalised on the way INTO the cache too: a mutation response is the
      // other door through which a non-array could reach a rendering list.
      qc.setQueryData(key, asRows<TRow>(rows));
      // AC-15's count lives on the repo's document list, under a key that does
      // NOT share a prefix with this one.
      qc.invalidateQueries({ queryKey: contextKeys.byRepo(repoId) });
    },
  });
}

/**
 * Attach one document to an agent.
 *
 * `repoId` is required by the API: it validates the submitted path against that
 * repository's discovered document set before persisting, which is the layer
 * that keeps an unknown path out of the table (the run-start resolver reads
 * persisted paths directly).
 */
export function useAttachAgentContextDoc(agentId: string, repoId: string | null | undefined) {
  // NO optimistic insert here, deliberately. Moving the row into the attached
  // list on `onMutate` would UNMOUNT the very control AC-25 requires to be
  // disabled while the mutation is in flight, and the two criteria then cannot
  // both hold. So an attach shows a disabled control and commits on the
  // response; AC-26's "restore the row's previous attachment state" is satisfied
  // because the row was never moved. The optimistic path is used for DETACH,
  // where the row genuinely disappears and a failure has something to restore.
  return useAttachmentMutation<string, AgentContextDoc>(
    contextKeys.agentDocs(agentId, repoId),
    repoId,
    (path) =>
      api.post<AgentContextDoc[]>(`/agents/${agentId}/context-docs`, {
        repo_id: repoId,
        path,
      }),
  );
}

/** Detach one document from an agent. */
export function useDetachAgentContextDoc(agentId: string, repoId: string | null | undefined) {
  return useAttachmentMutation<string, AgentContextDoc>(
    contextKeys.agentDocs(agentId, repoId),
    repoId,
    (path) =>
      api.del<AgentContextDoc[]>(
        `/agents/${agentId}/context-docs?path=${encodeURIComponent(path)}${
          repoId ? `&repo_id=${repoId}` : ""
        }`,
      ),
    (current, path) => current?.filter((r) => r.path !== path),
  );
}

/** AC-19 — persist a new order by sending the FULL ordered list, once. */
export function useSetAgentContextDocs(agentId: string, repoId: string | null | undefined) {
  return useAttachmentMutation<string[], AgentContextDoc>(
    contextKeys.agentDocs(agentId, repoId),
    repoId,
    (paths) =>
      api.put<AgentContextDoc[]>(`/agents/${agentId}/context-docs`, {
        repo_id: repoId,
        paths,
      }),
    (current, paths) => {
      if (!current) return undefined;
      const byPath = new Map(current.map((r) => [r.path, r]));
      return paths.flatMap((path, i) => {
        const row = byPath.get(path);
        return row ? [{ ...row, order: i }] : [];
      });
    },
  );
}

/** Attach one document to a skill (AC-20). */
export function useAttachSkillContextDoc(skillId: string, repoId: string | null | undefined) {
  // Same reasoning as `useAttachAgentContextDoc`: no optimistic insert, so the
  // in-flight control survives long enough to be disabled.
  return useAttachmentMutation<string, SkillContextDoc>(
    contextKeys.skillDocs(skillId, repoId),
    repoId,
    (path) =>
      api.post<SkillContextDoc[]>(`/skills/${skillId}/context-docs`, {
        repo_id: repoId,
        path,
      }),
  );
}

/** Detach one document from a skill. */
export function useDetachSkillContextDoc(skillId: string, repoId: string | null | undefined) {
  return useAttachmentMutation<string, SkillContextDoc>(
    contextKeys.skillDocs(skillId, repoId),
    repoId,
    (path) =>
      api.del<SkillContextDoc[]>(
        `/skills/${skillId}/context-docs?path=${encodeURIComponent(path)}${
          repoId ? `&repo_id=${repoId}` : ""
        }`,
      ),
    (current, path) => current?.filter((r) => r.path !== path),
  );
}
