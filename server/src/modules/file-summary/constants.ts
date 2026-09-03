/**
 * SPEC-03 — file-summary module constants.
 *
 * PUBLIC SURFACE. `no-cross-module-internals` whitelists `constants.ts` and
 * `types.ts`, so every number an acceptance criterion or NFR names lives here
 * and each is a one-line edit.
 */

/**
 * Job kind for a file-summary derivation. Part of the module's PUBLIC surface,
 * like every other job kind.
 *
 * The derivation goes through `JobRunner` rather than being awaited in the
 * request because it makes a model call over many files' patches. `JobRunner`
 * retries a REJECTED handler twice (`platform/jobs.ts` — `retries` defaults to
 * 2), which for a deterministic failure would mean THREE billed derivations —
 * which is why `deriveFileSummaries`' never-throws contract (AC-15) is
 * load-bearing rather than tidy.
 */
export const FILE_SUMMARY_DERIVE_JOB_KIND = 'file-summary.derive';

/**
 * json_schema / tool name of the file-summary extractor's structured output.
 *
 * MUST NOT COLLIDE with `INTENT_SCHEMA_NAME` (`'PrIntent'`) or
 * `BRIEF_SCHEMA_NAME` (`'PrRiskBrief'`): a collision poisons a provider's schema
 * cache and — worse, because it is silent — a test harness's
 * `MockLLMProvider.structuredBySchema` map, which is keyed on exactly this
 * string.
 */
export const FILE_SUMMARY_SCHEMA_NAME = 'PrFileSummaries';

/**
 * NFR-3 — the assembled prompt stays at or under this, counted with
 * `container.tokenizer`.
 *
 * THIS IS A COST CONTROL, NOT A SAFETY MARGIN. `deepseek/deepseek-v4-flash`'s
 * context window is 1 048 576 tokens with max completion 384 000 (not the
 * 131 072 the rendered model page shows), so 48 000 in + 2 000 out is ~4.8% of
 * the window and this cap fires roughly 20× below the provider limit. "Does
 * OpenRouter reject or silently truncate an oversized request" is therefore
 * unreachable by this feature — do not read this constant as a guard against
 * provider rejection. What it bounds is the dollar figure in NFR-1.
 */
export const FILE_SUMMARY_PROMPT_TOKEN_CAP = 48_000;

/**
 * AC-23's explicit `max_tokens`. SET EXPLICITLY AND NEVER OMITTED: omitting
 * `max_tokens` makes OpenRouter reserve the model's FULL output window against
 * the account balance and 402 a low-credit account BEFORE the call runs (root
 * `insights.md` 2026-08-22 — first-hand in this repository; OpenRouter
 * documents `max_tokens` as merely optional and documents the credit-reservation
 * mechanic nowhere).
 *
 * 2 000 is generous: at ~25 tokens per one-line summary, 28 files is ~700.
 */
export const FILE_SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

/**
 * AC-39 / NFR-2 — ONE HTTP request per derivation, full stop. The provider loops
 * `maxRetries + 1` times (`adapters/llm/openai.ts`), so any other value would
 * make AC-24's "exactly one structured completion request" false and turn
 * NFR-1's $0.02 ceiling into a per-attempt figure. A malformed answer is AC-27
 * immediately.
 */
export const FILE_SUMMARY_LLM_MAX_RETRIES = 0;

/**
 * NFR-4 / AC-28 / AC-74 — the persisted clamp, applied IN CODE because a strict
 * `json_schema` ignores `.max()`. AC-74 is the direction of the rule: an
 * over-long summary is truncated and KEPT, never a reason to reject the
 * derivation.
 */
export const MAX_FILE_SUMMARY_CHARS = 240;
