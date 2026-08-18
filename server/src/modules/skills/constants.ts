/** Constants for the skills module. */

/** Version recorded for a newly-created skill. */
export const INITIAL_SKILL_VERSION = 1;

/** Type a skill gets when the caller (or an import) doesn't name one. */
export const DEFAULT_SKILL_TYPE = 'custom' as const;

/** Source a skill gets when created through the editor rather than an import. */
export const DEFAULT_SKILL_SOURCE = 'manual' as const;
