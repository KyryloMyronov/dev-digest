import type { Skill, SkillSource } from "@devdigest/shared";
import { TYPE_COLOR } from "./constants";

/** Case-insensitive filter over a skill's name, description and type. */
export function filterSkills(skills: Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.type.includes(q),
  );
}

/** Chip colour for a skill's type. */
export function typeColor(skill: Pick<Skill, "type">): string {
  return TYPE_COLOR[skill.type] ?? "var(--text-secondary)";
}

/** Sources that did not originate in this workspace — badged in the UI. */
const FOREIGN_SOURCES: SkillSource[] = ["imported_url", "community"];

/**
 * True when the skill's text came from outside. The UI badges these because
 * they are the ones whose body goes into an agent's prompt as instructions
 * written by someone else — see `docs/skills/README.md`.
 */
export function isImported(skill: Pick<Skill, "source">): boolean {
  return FOREIGN_SOURCES.includes(skill.source);
}
