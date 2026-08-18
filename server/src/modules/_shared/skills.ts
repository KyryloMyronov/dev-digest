import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import type { SkillRow } from '../../db/rows.js';

/**
 * Skill mapping shared by more than one module.
 *
 * `skills` is owned by `modules/skills/`, but two other modules legitimately
 * need to *read* a skill row: `agents` inlines it into a link (the Skills tab)
 * and `reviews` renders its body into a prompt. Importing either module's
 * private helpers would cross `no-cross-module-internals`, so the pure
 * row → DTO and DTO → prompt-block functions live here, next to the shared row
 * types in `db/rows.ts` and for the same reason.
 *
 * Pure: no I/O, no `this`, no DB import beyond the inferred row type.
 */

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source as SkillSource,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
  };
}

/** Sources that did NOT originate in this workspace — labelled in the prompt. */
const FOREIGN_SOURCES: ReadonlySet<SkillSource> = new Set<SkillSource>([
  'imported_url',
  'community',
]);

/**
 * Render one skill as a prompt block.
 *
 * A skill is guidance, so its body goes in as INSTRUCTIONS — not wrapped in
 * `<untrusted>`. That is a deliberate trade: the shared `INJECTION_GUARD`
 * instructs the model to treat everything inside `<untrusted>` as inert data,
 * so wrapping a skill would reliably neutralise the very thing the user
 * attached it for. The mitigation is visibility rather than containment — the
 * heading carries the skill's name, type and, for anything imported, an
 * explicit `source: imported` marker, so the block is identifiable both in the
 * run trace's prompt-assembly view and by the model itself.
 *
 * What actually keeps this safe is upstream of here: an import is previewed in
 * full and saved only on confirmation, and a skill is text — nothing in this
 * pipeline executes, fetches or resolves anything out of a body.
 *
 * The description is included because it is the skill's interface: it states
 * directively what the skill is for, which is what lets the model decide
 * whether a given block applies to the diff in front of it.
 */
export function skillPromptBlock(skill: Skill): string {
  const foreign = FOREIGN_SOURCES.has(skill.source);
  const meta = [skill.type, `v${skill.version}`, ...(foreign ? ['source: imported'] : [])];
  const header = `### Skill: ${skill.name} (${meta.join(' · ')})`;
  const description = skill.description.trim();
  return description
    ? `${header}\n${description}\n\n${skill.body.trim()}`
    : `${header}\n${skill.body.trim()}`;
}
