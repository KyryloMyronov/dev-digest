import type { AgentSkillDetail, Skill, SkillType } from "@devdigest/shared";

/** Pure helpers for the agent Skills tab. */

/** Chip colour per skill type — mirrors the library's TYPE_COLOR. */
const TYPE_COLOR: Record<SkillType, string> = {
  rubric: "var(--info)",
  convention: "var(--ok, var(--text-secondary))",
  security: "var(--crit)",
  custom: "var(--text-secondary)",
};

export function typeColor(skill: Pick<Skill, "type">): string {
  return TYPE_COLOR[skill.type] ?? "var(--text-secondary)";
}

/**
 * Move one item to a new index, returning a NEW array.
 *
 * Out-of-range targets return the list unchanged rather than clamping: the
 * caller only ever produces a valid index (the arrows are disabled at the ends),
 * so an out-of-range value means a bug upstream, and silently clamping it would
 * save a reorder the user did not ask for.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...items];
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1) as [T];
  next.splice(to, 0, moved);
  return next;
}

/**
 * Ordered links → the wire payload for `POST /agents/:id/skills`.
 *
 * `enabled` is carried through explicitly. Dropping it would let the server's
 * "attach enabled by default" kick in and silently re-enable every disabled
 * skill on any reorder.
 */
export function toLinkPayload(
  links: readonly AgentSkillDetail[],
): { skill_id: string; enabled: boolean }[] {
  return links.map((l) => ({ skill_id: l.skill_id, enabled: l.enabled }));
}
