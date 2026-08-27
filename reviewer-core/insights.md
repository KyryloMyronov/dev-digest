# reviewer-core — insights

Append-only log of things that cost real time. Newest first. One entry per
gotcha; if it becomes a rule everyone must follow, promote it to `CLAUDE.md` and
leave the entry here as the explanation.

Format: `## YYYY-MM-DD — one-line title` then symptom → cause → fix.

Entries also carry `**Rubric:**` — one of: What Works · What Doesn't Work ·
Codebase Patterns · Tool & Library Notes · Recurring Errors & Fixes ·
Session Notes · Open Questions. Find one with
`grep -n '^\*\*Rubric:\*\* Open Questions' insights.md`. Written by the
`engineering-insights` skill; see `../.claude/skills/engineering-insights/`.

---

## 2026-08-22 — OpenRouter 402 "requires more credits, or fewer max_tokens" = a request that sent no `max_tokens`

**Rubric:** Recurring Errors & Fixes
**Symptom:** every review fails with `402 This request requires more credits,
or fewer max_tokens. You requested up to 65536 tokens` — even though the review
output would only be a few thousand tokens and the account has (some) credits.
**Cause:** when a request omits `max_tokens`, OpenRouter's pre-flight credit
check reserves the MODEL's maximum output window (65 536 for the model above)
against the account balance, so a small balance is rejected before anything
runs. `OpenRouterProvider.completeStructured` only forwarded `max_tokens` when
the caller set `req.maxTokens`, and the review path (`review/run.ts`) never
does.
**Fix:** the provider now always sends `max_tokens: req.maxTokens ?? 8_192`
(`src/llm/openrouter.ts`, pinned by `test/openrouter.test.ts`) — big enough for
a structured Review plus reasoning tokens, small enough for low balances. If
the 402 still appears, the balance can't even cover prompt + 8 192 reserved
output tokens: top up, or pass a smaller `maxTokens` / cheaper model. Same trap
applies to any future OpenRouter call site: never send a request without an
output cap.

## 2026-07-30 — this package is npm, and forgetting that breaks the server

**Rubric:** Recurring Errors & Fixes
**Symptom:** `pnpm install` at the repo root or in `server/` appears to succeed,
then the API dies at boot with `ERR_MODULE_NOT_FOUND`.
**Cause:** `reviewer-core` has a `package-lock.json`, not a `pnpm-lock.yaml`, and
nothing else installs it. Its deps are the *server's* runtime deps because the
server imports its raw source.
**Fix:** `npm ci` here. See `scripts/dev.sh:77-80`, which documents the same
trap.

## 2026-07-30 — zod is deliberately pinned to this package's own node_modules

**Rubric:** Tool & Library Notes
**Symptom:** none if left alone; removing the tsconfig path makes
`instanceof z.ZodError` fail intermittently in the server's error handler.
**Cause:** two resolved zod instances → two distinct `ZodError` classes.
**Fix:** keep `"zod": ["./node_modules/zod"]` in `tsconfig.json`. The server also
defends structurally (`app.ts:138`), but that's belt-and-braces, not permission
to remove the pin.

## 2026-07-30 — `@devdigest/shared` resolves backwards into `server/`

**Rubric:** Open Questions
**Symptom:** attempting to extract or publish this package fails to resolve its
own contracts.
**Cause:** `tsconfig.json` aliases `@devdigest/shared` to
`../server/src/vendor/shared` — the pure package depends on a path inside the
impure one.
**Fix:** none needed today; it's a known constraint. Extracting reviewer-core
(e.g. for the L04 MCP server) requires moving `shared` to its own package first.
That is a prerequisite, not a side quest.

## 2026-07-30 — grounding exempts four finding kinds from line anchoring

**Rubric:** Codebase Patterns
**Symptom:** a full-file finding (secret scan, phantom check) is dropped as
"hallucinated" when its line range doesn't hit a hunk.
**Cause:** the citation gate requires a hunk intersection by default.
**Fix:** `kind` in `{secret_leak, lethal_trifecta, phantom, hook}` is treated as
full-file and only requires the file to appear in the diff
(`src/grounding.ts:17`). A new full-file finding kind must be added to that set,
and the spec must say so — see `specs/README.md`.

## 2026-07-30 — the reported score is recomputed, not the model's

**Rubric:** Codebase Patterns
**Symptom:** the score doesn't match what the model returned.
**Cause:** intentional. `score` is derived from the findings that survived
grounding (`src/review/run.ts:238`), so score, findings, and verdict can never
contradict each other.
**Fix:** nothing — don't "restore" the model's self-reported score.