/**
 * Conventions module constants — this module's public surface, alongside
 * `types.ts`. Nothing else here may be imported from another module.
 */

/** Job kind for a repo conventions scan. */
export const CONVENTIONS_SCAN_JOB_KIND = 'conventions-scan';

/**
 * How many ranked paths to offer the selector. Paths only, so this is cheap —
 * the cost is in reading and sending the files the model picks out of it.
 */
export const SAMPLE_FILE_COUNT = 80;

/** Hard cap on files actually read and sent. The handler runs under a 120s timeout. */
export const MAX_SELECTED_FILES = 12;

/** Per-file read cap. A generated or vendored monster would otherwise eat the budget. */
export const MAX_FILE_BYTES = 24_000;

export const MAX_RULE_CHARS = 300;
export const MAX_SNIPPET_CHARS = 400;

/**
 * Schema names for the two-step dialogue. `MockLLMProvider.structuredBySchema`
 * keys fixtures off these exact strings, which is what lets the scan be tested
 * hermetically — do not rename one without the other.
 */
export const SELECTION_SCHEMA_NAME = 'ConventionFileSelection';
export const EXTRACTION_SCHEMA_NAME = 'ConventionExtraction';

/** What a skill composed from conventions is created as. */
export const DRAFT_SKILL_TYPE = 'convention' as const;
export const DRAFT_SKILL_SOURCE = 'extracted' as const;

/** Suffix for the composed skill's name: `<repo>-conventions`. */
export const DRAFT_NAME_SUFFIX = '-conventions';
