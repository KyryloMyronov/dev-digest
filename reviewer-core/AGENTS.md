# `@devdigest/reviewer-core` — the review engine

Pipeline stages and public API: [`README.md`](README.md).
Root rules: [`../CLAUDE.md`](../CLAUDE.md).

## Stack

`openai` 4 (types only, for the OpenAI-compatible OpenRouter client) · Zod 3 ·
TypeScript 5.7 · Vitest 2.1. **npm**, not pnpm. No framework, no DB driver, no
HTTP server — that is the point.

## Commands

```sh
npm ci                  # NOT pnpm — this package has a package-lock.json
npm run typecheck       # tsc --noEmit
npm run build           # also just tsc --noEmit; this package never emits JS
npm test                # vitest
```

## Where things live

```
src/prompt.ts           prompt assembly + injection hardening
src/grounding.ts        the citation gate
src/llm/structured.ts   Zod → JSON Schema, parse-with-repair
src/llm/openrouter.ts   the one OpenAI-compatible provider
src/review/run.ts       reviewPullRequest — the entry point
src/review/reduce.ts    map-reduce merge + score derivation
src/output/to-review.ts grounded Review → GitHub review payload
```

## Non-default conventions

- **PURITY IS THE CONTRACT.** No database, no GitHub, no filesystem, no `env`,
  no network. The *only* side effect permitted is a call through the **injected**
  `LLMProvider`. If a change needs I/O, it belongs in the caller (the server
  persists and streams; the CI runner posts and writes an artifact). This is what
  lets one engine serve both, and what makes it mock-testable.
- **This package never emits JavaScript.** `build` is a type-check. Consumers
  compile the raw source through a tsconfig path alias, so there is no dist to
  keep in sync — and no build step to forget.
- **Inputs are resolved strings, not identifiers.** Skills, memory, and specs
  arrive as bodies; the caller turns slugs into text (DB in the studio, fs in the
  runner). Never look anything up in here.
- **The citation-grounding gate is shared and runs once**, after reduce, for
  every strategy. Don't reimplement it per path or move it inside the loop.
- **The score is derived from findings that SURVIVED grounding** — not the
  model's self-reported number, not the pre-grounding set. Score, findings list,
  and verdict must never be able to disagree.
- **All external text goes through `wrapUntrusted`.** The injection guard is
  appended centrally in `assemblePrompt`, so it covers every path — never
  pattern-match untrusted text downstream instead.
- **Cancellation is an injected `checkCancelled()` that throws.** The engine
  stays agnostic of the caller's error type; don't import one.

## Gotchas

- **`npm ci` here, or the *server* breaks.** The API imports this package's raw
  source at runtime, so an empty `reviewer-core/node_modules` surfaces as
  `ERR_MODULE_NOT_FOUND` at server boot, pointing at a file in `server/`.
- **zod is pinned to this package's own `node_modules`** via a tsconfig path
  (`"zod": ["./node_modules/zod"]`). This prevents a second zod instance, which
  would break `instanceof z.ZodError` across the package boundary. Don't remove
  that path mapping.
- **`@devdigest/shared` resolves *backwards* into `../server/src/vendor/shared`.**
  The pure package depends on a path inside the impure one, so this package
  cannot be extracted until `shared` moves out first.
- Findings whose `kind` is `secret_leak`, `lethal_trifecta`, `phantom`, or `hook`
  are treated as **full-file** by grounding: they only require the file to appear
  in the diff, not a line-range intersection.
- `strategy: 'auto'` picks map-reduce only when the diff is **both** large and
  multi-file — a single huge file stays one call.

## Do-not-touch

- `node_modules/` and `package-lock.json` — managed by npm; don't switch this
  package to pnpm without re-reading `../scripts/dev.sh:77-80`.

## Docs

Pipeline & public API → [`README.md`](README.md) ·
Prompt authoring, slot order, output conventions → [`../docs/agent-prompts/`](../docs/agent-prompts/README.md) ·
Learned gotchas → [`insights.md`](insights.md) · Unbuilt work → [`specs/`](specs/README.md)

Relevant skills: `zod`, `typescript-expert`, `claude-api` (model ids, pricing,
structured output).