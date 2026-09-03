import type { EvalExpectation } from "@devdigest/shared";

/**
 * AC-77 — the two options of the expectation control.
 *
 * A LOCAL LITERAL ARRAY annotated with the contract type, NEVER the imported
 * `EvalExpectation` Zod enum: a runtime (value) import from `@devdigest/shared`
 * breaks the browser build while `pnpm typecheck` and `pnpm test` both stay
 * green (`client/insights.md` 2026-08-11). `SkillsListView/constants.ts`'s
 * `TYPE_OPTIONS` is the pattern.
 */
export const EXPECTATION_OPTIONS: EvalExpectation[] = ["must_find", "must_not_flag"];

/** The two input tabs. The Files tab drawn in `img_5` is a Non-goal. */
export const INPUT_TABS = ["diff", "prMeta"] as const;
export type InputTab = (typeof INPUT_TABS)[number];
