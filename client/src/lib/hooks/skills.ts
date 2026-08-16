/* hooks/skills.ts — React Query hooks for the Skills library and for an agent's
   skill links. Skills are workspace-wide and reusable; the link is what makes
   one apply to a given agent, and the link's `enabled` is what puts its body in
   that agent's prompt. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentSkillDetail, Skill, SkillType, SkillVersion } from "@devdigest/shared";
import { agentKeys, skillKeys } from "./keys";

// ---- The library -----------------------------------------------------------

export function useSkills() {
  return useQuery({
    queryKey: skillKeys.all,
    queryFn: () => api.get<Skill[]>("/skills"),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: skillKeys.detail(id),
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    enabled: !!id,
  });
}

/** Body history for a skill, newest first. Only fetched when a panel asks. */
export function useSkillVersions(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: skillKeys.versions(id),
    queryFn: () => api.get<SkillVersion[]>(`/skills/${id}/versions`),
    enabled: !!id && enabled,
  });
}

/** Names of agents linking a skill — read before offering to delete it. */
export function useSkillAgents(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: skillKeys.agents(id),
    queryFn: () => api.get<string[]>(`/skills/${id}/agents`),
    enabled: !!id && enabled,
  });
}

export interface CreateSkillInput {
  name: string;
  description: string;
  type?: SkillType;
  /** Omit for a hand-written skill; imports pass their real origin. */
  source?: Skill["source"];
  body: string;
  enabled?: boolean;
  /** Files the body was derived from — set when saving a conventions draft. */
  evidence_files?: string[];
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: Partial<Pick<Skill, "name" | "description" | "type" | "body" | "enabled">>;
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSkillInput) => api.put<Skill>(`/skills/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: skillKeys.all });
      qc.setQueryData(skillKeys.detail(data.id), data);
      // A body edit mints a new version, and every agent link now renders a
      // different block — both lists are stale.
      qc.invalidateQueries({ queryKey: skillKeys.versions(data.id) });
      qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: skillKeys.all });
      qc.removeQueries({ queryKey: skillKeys.detail(id) });
      // The delete cascades through agent_skills, so every agent's link list can
      // have changed — not just the ones we happened to have fetched.
      qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

// ---- An agent's links ------------------------------------------------------

/** The agent's linked skills, ordered, each with its skill inlined. */
export function useAgentSkills(agentId: string | null | undefined) {
  return useQuery({
    queryKey: agentKeys.skills(agentId),
    queryFn: () => api.get<AgentSkillDetail[]>(`/agents/${agentId}/skills`),
    enabled: !!agentId,
  });
}

/**
 * Every link mutation returns the agent's full, re-ordered link list, so the
 * cache is seeded from the response rather than invalidated — a reorder that
 * refetched would flash the old order between the drop and the response.
 */
function useLinkMutation<TVars>(
  agentId: string,
  fn: (vars: TVars) => Promise<AgentSkillDetail[]>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (links) => {
      qc.setQueryData(agentKeys.skills(agentId), links);
      // The Agents list shows a per-agent skill count.
      qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

/** Replace the whole ordered set — used by attach, detach-by-omission and drag. */
export function useSetAgentSkills(agentId: string) {
  return useLinkMutation<{ skill_id: string; enabled?: boolean }[]>(agentId, (links) =>
    api.post<AgentSkillDetail[]>(`/agents/${agentId}/skills`, { links }),
  );
}

/** Flip one link's per-agent switch, leaving its position alone. */
export function useToggleAgentSkill(agentId: string) {
  return useLinkMutation<{ skillId: string; enabled: boolean }>(agentId, ({ skillId, enabled }) =>
    api.patch<AgentSkillDetail[]>(`/agents/${agentId}/skills/${skillId}`, { enabled }),
  );
}

/** Detach a skill from this agent. The skill itself is untouched. */
export function useUnlinkAgentSkill(agentId: string) {
  return useLinkMutation<string>(agentId, (skillId) =>
    api.del<AgentSkillDetail[]>(`/agents/${agentId}/skills/${skillId}`),
  );
}
