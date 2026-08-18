import type { SkillType } from "@devdigest/shared";

/**
 * The types offered in the create-skill dropdown, in the order they are shown.
 *
 * A literal array, NOT `SkillType.options`, even though the enum is right there
 * in the contract. Reading `.options` imports a VALUE from `@devdigest/shared`,
 * and nothing else in the client does — every other import is `import type`,
 * which `tsc` erases. A value import makes the bundler resolve the contract
 * barrel for real, and `vendor/shared/index.ts` re-exports with ESM `.js`
 * specifiers (`export * from './contracts/findings.js'`) that resolve under
 * `tsc` but not under webpack. The result is a route that typechecks and passes
 * its tests, then fails in the browser with
 * `Can't resolve './contracts/findings.js'`.
 *
 * Mirrors `app/skills/.../SkillsListView/constants.ts#TYPE_OPTIONS`, which made
 * the same call. Typed as `SkillType[]` so a value the contract does not have is
 * still a compile error.
 */
export const SKILL_TYPE_OPTIONS: SkillType[] = [
  "rubric",
  "convention",
  "security",
  "custom",
];

/** Skeleton cards shown while the first read is in flight. */
export const SKELETON_CARDS = 3;

/** Height of one skeleton card — roughly a real card with a 2-line snippet. */
export const SKELETON_HEIGHT = 150;

export const CREATE_SKILL_MODAL_WIDTH = 860;

/** Width of the confidence meter. Wide enough to read, narrow enough to sit inline. */
export const CONFIDENCE_BAR_WIDTH = 130;

/**
 * Confidence colour thresholds, as PERCENTAGES.
 *
 * Copied from `vendor/ui/primitives/ConfidenceNum.tsx` so the meter here and the
 * kit's numeric readout cannot disagree about what counts as a good score.
 */
export const CONFIDENCE_OK = 85;
export const CONFIDENCE_WARN = 65;

/** Characters per token — the estimate used after the user edits the body. */
export const CHARS_PER_TOKEN = 4;
