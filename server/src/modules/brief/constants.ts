/**
 * SPEC-02 — brief module constants.
 *
 * PUBLIC SURFACE. `no-cross-module-internals` whitelists `constants.ts` and
 * `types.ts`, so every number an acceptance criterion or NFR names lives here
 * and is a one-line edit.
 */

/**
 * Job kind for a brief derivation. Part of the module's PUBLIC surface, like
 * every other job kind.
 *
 * The derivation goes through `JobRunner` rather than being awaited in the
 * request because it makes a model call over the whole diff. `JobRunner`
 * retries a REJECTED handler twice (`platform/jobs.ts` — `retries` defaults to
 * 2) — which for a deterministic failure would mean THREE billed derivations —
 * so the handler must keep `deriveBrief`'s never-throws contract (AC-10) and
 * let the pipeline persist its own outcome.
 */
export const BRIEF_DERIVE_JOB_KIND = 'brief.derive';

/**
 * json_schema / tool name of the brief extractor's structured output.
 *
 * `'PrRiskBrief'`, NOT `'PrBrief'`: `INTENT_SCHEMA_NAME` is `'PrIntent'` and the
 * two must not collide in a provider's schema cache or in a test harness's
 * `MockLLMProvider.structuredBySchema` map.
 */
export const BRIEF_SCHEMA_NAME = 'PrRiskBrief';

/** NFR-3 — the assembled prompt stays at or under this (D-1). */
export const BRIEF_PROMPT_TOKEN_CAP = 24_000;

/**
 * NFR-4's output half. SET EXPLICITLY AND NEVER OMITTED: omitting `max_tokens`
 * makes OpenRouter reserve the model's full output window against the account
 * balance and 402 a low-credit account BEFORE the call runs (root
 * `insights.md` 2026-08-… — first-hand in this repository; OpenRouter
 * documents `max_tokens` as merely optional and documents the credit
 * reservation mechanic nowhere).
 */
export const BRIEF_MAX_OUTPUT_TOKENS = 2_000;

/**
 * D-5 / AC-14 — ONE HTTP request per derivation, full stop. The provider loops
 * `maxRetries + 1` times (`adapters/llm/openai.ts`), so any other value would
 * make "exactly one structured completion request" false and turn NFR-4's
 * $0.07 into a per-attempt figure. A malformed answer is AC-15 immediately.
 */
export const BRIEF_LLM_MAX_RETRIES = 0;

/**
 * AC-16's persisted clamp. The CARD shows at most ten
 * (`BRIEF_RISK_DISPLAY_CAP` in the client's BriefCard/constants.ts). THE TWO
 * NUMBERS DIFFER ON PURPOSE (D-4): 20 persisted, 10 shown, which is what makes
 * AC-39's "showing X of Y" line reachable at all.
 */
export const MAX_BRIEF_RISKS = 20;

/** AC-16 clamp / AC-40 — at most five review-focus entries. */
export const MAX_FOCUS_ENTRIES = 5;

/** Output clamps applied in code (strict json_schema ignores `.max()`). */
export const MAX_RISK_TITLE_CHARS = 200;
export const MAX_RISK_EXPLANATION_CHARS = 600;
export const MAX_FOCUS_REASON_CHARS = 200;
export const MAX_WHY_SUMMARY_CHARS = 800;
