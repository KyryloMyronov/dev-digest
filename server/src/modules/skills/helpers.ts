import type { SkillVersion } from '@devdigest/shared';
import type { SkillRow, SkillVersionRow } from '../../db/rows.js';

/**
 * Pure helpers for the skills module — the version-bump rule and version
 * mapping. No I/O, no `this`.
 *
 * `toSkillDto` is NOT here: `agents` and `reviews` map skill rows too, so it
 * lives in `modules/_shared/skills.ts` and is re-exported below for callers
 * inside this module.
 */

export { toSkillDto } from '../_shared/skills.js';

/** Map a `skill_versions` row to the public `SkillVersion` DTO. */
export function toSkillVersionDto(row: SkillVersionRow): SkillVersion {
  return {
    skill_id: row.skillId,
    version: row.version,
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * True when a patch changes the skill's BODY — the only field that gets an
 * immutable snapshot in `skill_versions`.
 *
 * Deliberately narrower than the agents' `isConfigChange`: renaming a skill or
 * retyping it does not change what lands in a prompt, so versioning those would
 * fill the history with entries no run could ever differ on. The prompt only
 * ever sees `body` (plus the name/source header the reviews module renders).
 */
export function isBodyChange(existing: Pick<SkillRow, 'body'>, patch: { body?: string }): boolean {
  return patch.body !== undefined && patch.body !== existing.body;
}
