/**
 * Review module constants.
 */

/**
 * Studio review strategy. 'single-pass' = send the WHOLE diff in ONE LLM call.
 * We deliberately do NOT use 'auto'/map-reduce by default: map-reduce makes one
 * call PER FILE, which is slow and fragile (any single file's transient 5xx
 * fails the entire run) and unnecessary — the whole diff already fits the
 * model's context.
 */
export const REVIEW_STRATEGY = 'single-pass' as const;

// ---------------------------------------------------------------- L03 · intent

/** json_schema / tool name of the intent classifier's structured output. */
export const INTENT_SCHEMA_NAME = 'PrIntent';

/**
 * Job kind for a manual re-derivation. Part of the module's PUBLIC surface, like
 * every other job kind.
 *
 * The derivation goes through `JobRunner` rather than being awaited in the
 * request because it makes a model call, a GitHub call and up to two clone
 * reads. `JobRunner` retries a REJECTED handler twice — which for a
 * deterministic failure would mean three billed derivations — so the handler
 * must keep `deriveIntent`'s never-throws contract and let the pipeline persist
 * its own outcome.
 */
export const INTENT_DERIVE_JOB_KIND = 'intent.derive';

/**
 * Below this, a PR body is boilerplate (a template with nothing filled in, a
 * one-liner) rather than documentation, so it does not lift the confidence cap.
 * It is still SENT to the classifier — a short body can still say why.
 */
export const MIN_BODY_CHARS = 200;

/**
 * The ceiling on confidence when nothing documented was available (no usable
 * body, no linked ticket, no plan/spec). The model's own number is capped, never
 * trusted: self-reported LLM confidence sits in 80–100% almost regardless of
 * evidence, so "high confidence from a title and a branch name" is a shape of
 * answer we refuse to produce rather than one we hope not to receive.
 */
export const INDIRECT_CONFIDENCE_CAP = 0.45;

/** Plan/spec resolution limits — the paths come from author-controlled text. */
export const MAX_SPEC_FILES = 2;
export const MAX_SPEC_BYTES = 12_000;

/** Signal caps, so a huge PR cannot blow the cheap model's context. */
export const MAX_INTENT_COMMITS = 20;
export const MAX_INTENT_FILES = 60;

/** Output clamps applied in code (strict json_schema ignores `.max()`). */
export const MAX_INTENT_CHARS = 600;
export const MAX_SCOPE_ITEMS = 8;
export const MAX_SCOPE_ITEM_CHARS = 300;
