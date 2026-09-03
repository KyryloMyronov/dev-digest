# root — insights

Cross-cutting only: `scripts/`, `docs/`, `.github/`, root configs, and fixes
that span two packages. Anything belonging to one package goes in that
package's own `insights.md`.

Append-only log of things that cost real time. Newest first. One entry per
gotcha; if it becomes a rule everyone must follow, promote it to `CLAUDE.md` and
leave the entry here as the explanation.

Format: `## YYYY-MM-DD — one-line title` then symptom → cause → fix.

Entries also carry `**Rubric:**` — one of: What Works · What Doesn't Work ·
Codebase Patterns · Tool & Library Notes · Recurring Errors & Fixes ·
Session Notes · Open Questions. Find one with
`grep -n '^\*\*Rubric:\*\* Open Questions' insights.md`. Written by the
`engineering-insights` skill; see `.claude/skills/engineering-insights/`.

---

## 2026-08-29 — a green test can pass with its own mechanism DELETED, when the fixture satisfies the assertion by another route

**Rubric:** What Works
**Symptom:** SPEC-03's plan specified an NFR test to prove a read projection
bounds a payload: derive, force-push, derive again, then assert the response size.
The builder deleted the ordering term the whole projection rests on —
`ORDER BY path, (head_sha = pull.head_sha) DESC, created_at DESC` — and **the test
stayed green.**
**Cause:** the fixture only ever moved the head *forward*, so the current head's
row was also the newest, and `created_at DESC` alone produced the same answer.
The assertion was true for a reason unrelated to the mechanism it was written to
pin. The plan's own verification recipe was insufficient, and no reviewer would
have caught it — the test looked right, named the right criterion, and passed.
**Fix:** for any test that exists to pin a **mechanism** (an ordering term, a
tie-break, a cap, a guard clause), delete the mechanism and confirm the test goes
red *before* trusting it green. When it does not, the fixture is the problem —
build one where the mechanism is the *only* thing that can produce the answer.
Here: force-push **back** to an earlier head (a revert or reset), so the correct
row is deliberately **older** than the wrong one:

```
derive at A → force-push to B, derive → force-push back to A
              → A's row is older, and must still win
```

This is the same technique as the 2026-08-27 entry below, generalised past
security properties: **that** entry is about an observable one step removed from
the property; this one is about a fixture that reaches the right answer down the
wrong path. Both are cheap — one edit, one run, one revert — and both found a
real defect on their first use. Budget a mutation check per mechanism-pinning
test, not per suite.

## 2026-08-28 — `server/test/contracts.test.ts` is a second, invisible consumer of every `vendor/shared` shape; no "who reads this contract" audit finds it

**Rubric:** What Doesn't Work
**Symptom:** SPEC-02 retyped `Risk` in `server/src/vendor/shared/contracts/brief.ts`.
Its plan's *Impact map* and NFR-11 both stated, in as many words, that the MCP
five-tool assertion was **"the one real break"**, backed by "a grep across
`server/src`, `client/src`, `mcp/src`, `reviewer-core/src` and `e2e/`". Mid-build
a second suite failed:

```
FAIL test/contracts.test.ts > Intent / BlastRadius / Risks / PrHistory
  "path": ["risks", 0, "end_line"], "message": "Required"
```

**Cause:** the audit grepped **`server/src`, not `server/test`**.
`server/test/contracts.test.ts` builds literal fixtures for the shared shapes and
parses them, so it consumes *every* contract while living outside every source
tree anyone thinks to search. Nor do the tooling checks catch it:
`.claude/skills/api-breaking-changes/check.mjs` extracts consumers from
`client/src/**` `api.get/post` call sites, and `response-schema` reasons about
what routes *return* — a test-only constructor is invisible to both. Its severity
text even says the risk out loud ("breaking for anything that **constructs** this
shape (fixtures, seeds, adapters)") without being able to point at this file.
**Fix:** when changing anything under `vendor/shared/`, grep the **test trees
too**:

```sh
grep -rnw '<TypeName>' server/src client/src mcp/src reviewer-core/src server/test client/src e2e
```

Fixing it forward is cheap and should strengthen, not loosen: update the fixture
to the new shape **and** add an assertion that the new required fields are
enforced (`expect(() => Schema.parse({ …missing… })).toThrow()`), which is what
SPEC-02 did. Do not relax the fixture to make it pass. Related:
`server/src/db/seed.ts` is the *other* place shapes get constructed — it happened
to carry no `pr_brief` row here, but check it every time.

## 2026-08-28 — a model-authored free-string `kind` reaching `FULL_FILE_KINDS` silently disables line anchoring; pass fresh literals, never a spread

**Rubric:** Codebase Patterns
**Symptom:** none yet — caught in design and guarded before it shipped. This is
the latent shape, recorded so nobody reintroduces it.
**Cause:** `reviewer-core/src/grounding.ts` exempts `kind` in
`{secret_leak, lethal_trifecta, phantom, hook}` from hunk intersection, requiring
only that the file appear in the diff (see `reviewer-core/insights.md`,
2026-07-30). That set is safe while `kind` is **ours**. SPEC-02's brief pipeline
made `kind` a field of a **model-authored** `Risk`, so a model emitting
`kind: "phantom"` with a fabricated line range would have been exempted from
anchoring and persisted as a grounded citation — defeating the citation gate
entirely, from untrusted input, with no error anywhere.
**Fix:** never hand a model-shaped object to the gate. Build **fresh literals**
carrying only the geometry, plus an index to re-associate survivors:

```ts
groundCitations(
  risks.map((r, i) => ({ file: r.file, start_line: r.start_line, end_line: r.end_line, i })),
  diff,
);   // NOT risks.map(r => ({ ...r }))  — a spread carries `kind` straight through
```

Re-attach `kind` **after** gating. `server/src/modules/brief/pipeline.ts`
(`groundBrief`) is the worked example, with the warning also written on the
contract field itself (`vendor/shared/contracts/brief.ts`) so it is visible at the
point of temptation. **Generalise:** any allow-list keyed on a string that can
originate from a model is a bypass unless the value is re-derived from trusted
data first.

## 2026-08-27 — a subagent's self-reported deviation list beats the reviewers' findings; ask for it explicitly and read it first

**Rubric:** What Works
**Symptom:** across a 33-step build, `implementer` self-reported **9 deviations**
in one cut and **15** in the next. Two `plan-verifier` passes confirmed all 24 as
described. Meanwhile three review rounds (`architecture-reviewer` ×3,
`plan-verifier` ×3, four skill checks ×2) produced **0 blocking** findings
between them. The single most valuable item in the whole review cycle came from a
**follow-up line in the builder's own report**, not from a reviewer: it noted
that the containment fix it had just been told to write could not see a symlinked
*directory* component. That was a live security hole in a fix the coordinator had
prescribed as sufficient.
**Cause:** a deviation is cheap for the agent that made it and expensive for a
reviewer to discover — the builder knows where it departed from the instructions;
a reviewer has to re-derive it from the diff. The asymmetry is large enough that
the list is a better-yield artifact than an independent pass.
**Fix:** put it in the prompt as a required report section, in these words or
close: *"every deviation from a literal reading of the plan"*, and say that the
previous build's list was the highest-value part of its report. Then **read the
deviations and follow-ups before the findings**, and hand the list to
`plan-verifier` as its named highest-value target — verifying a disclosed
deviation is a diff-read, whereas finding one is a search. Corollary: do **not**
treat a long deviation list as a bad sign. The build with 15 deviations was the
cleaner of the two.

## 2026-08-27 — mutation-check any test that pins a security property, or it pins the symptom instead

**Rubric:** What Works
**Symptom:** a resolver was told not to read a symlinked document, and to record
it as `{ reason: 'unread' }`. A test asserting the *reason* passes against an
implementation that reads the file, discards the bytes, and reports `unread`
anyway — the byte still left the disk and could still land in a log or a prompt.
The same trap in reverse: the first symlink test swapped only the *file*, so it
passed against a fix that missed the *directory* vector entirely.
**Cause:** the observable a criterion names (a reason code, a status) is usually
one step removed from the property that matters (the absence of a read). Tests
default to the named observable.
**Fix:** two habits, both cheap.
1. **Assert the absence, not the label** — `expect(readFile.mock.calls).toEqual(['specs/ok.md'])`
   and `expect(texts.join('\n')).not.toContain('SECRET')`, not just the reason
   field.
2. **Mutation-check it**: break the guard (`if (false && …)`), run the one test,
   and **quote the failure message** in the report. Then revert and
   `grep -c 'false &&'` to prove you did. Three fixes in this build were checked
   this way; each produced a failure that named the real vector
   (`expected [ 'specs/sub/foo.md', 'specs/ok.md' ] to deeply equal [ 'specs/ok.md' ]`),
   and one of them is the only reason a known-insufficient fix did not ship.

## 2026-08-27 — `git diff --stat <file>` silently returns nothing for an untracked module, so the "did the fix touch this file" check is a no-op

**Rubric:** What Doesn't Work
**Symptom:** the review-loop step that spends a `git diff --stat <path>` to avoid
paying for a re-review — a row whose file the fix never touched is
`not-attempted`, not disputed — printed empty output for all five files of a
just-completed fix iteration. Read naively that says "nothing was touched" and
sends every row back.
**Cause:** the whole new module (`server/src/modules/project-context/**`) was
**untracked**, and nothing on the branch was committed, so `git diff` has no
index entry to diff against and exits 0 with no output. Empty output is
indistinguishable from "unchanged".
**Fix:** never read an empty `git diff` as evidence of anything until you know
the path is tracked. Check `git status --porcelain <path>` first — `??` means
`git diff` will lie. For an untracked tree the working substitutes are a
`grep -n` for the symbol or guard the fix was supposed to add, or an `mtime`
comparison (`find <dir> -newermt "<time>"`). Both are what actually confirmed
this iteration. The same trap applies to any `git diff`-based gate in a repo
where a feature ships as new files on an uncommitted branch.

## 2026-08-22 — omitting `max_tokens` makes OpenRouter 402 low-credit accounts before the call even runs

**Rubric:** Recurring Errors & Fixes
**Symptom:** every review run fails with `402 This request requires more
credits, or fewer max_tokens. You requested up to 65536 tokens, but can only
afford N`, even though the actual completion would cost a fraction of a cent.
**Cause:** `OpenRouterProvider.completeStructured` sent `max_tokens` only when
`req.maxTokens` was set — and **no call site in the repo ever sets it**. With
the field absent, OpenRouter reserves the model's FULL output window (65 536
for deepseek-v4-flash) against the account balance as a pre-flight check, so
any account holding less than that reservation is rejected outright.
**Fix:** spans reviewer-core + server. The provider now always sends
`max_tokens` (`reviewer-core/src/llm/openrouter.ts` — injected
`defaultMaxTokens`, built-in default 8192; reviewer-core is pure, so the value
is an option, never `env`). The server threads `LLM_MAX_OUTPUT_TOKENS`
(default 8192) through `platform/config.ts` → `container.buildLlm`. Still
seeing the 402 → the balance is below even 8192: lower
`LLM_MAX_OUTPUT_TOKENS` in `server/.env` or top up. Reviews truncated → raise
it. A request's own `maxTokens` always wins over the default.

## 2026-08-21 — `mcp/` fronts the REST API on purpose; importing `@devdigest/shared` into it would chain it to the server tree

**Rubric:** Codebase Patterns
**Symptom:** none yet — latent. The temptation is real: `mcp/src/api.ts` hand-declares
minimal projections (`AgentDto`, `ReviewRecord`, …) that visibly "duplicate"
`server/src/vendor/shared/contracts/*`, and a cleanup that replaces them with
`@devdigest/shared` imports would typecheck.
**Cause:** `@devdigest/shared` resolves backwards into `server/src/vendor/shared/`
via tsconfig aliases (see `reviewer-core/insights.md` 2026-08-05 — the L04
extraction blocker). The new `mcp/` package (npm, standalone, stdio MCP server)
sidesteps that prerequisite entirely by treating the REST API on :3001 as its
contract and keeping its own lean type projections. Wiring shared in would make
`mcp/` un-extractable and drag the server's zod pin (`^3.24.1`) into conflict
with `@modelcontextprotocol/sdk`, whose floor is zod `^3.25` (it imports the
`zod/v4` subpath, absent before 3.25) — `mcp/package.json` pins `^3.25.0` for
that reason.
**Fix:** keep `mcp/` REST-only. New tool needs a field? Extend the projection in
`mcp/src/api.ts`, don't import shared. Two more facts that cost time here:
per-run findings have **no endpoint** — join `GET /pulls/:id/reviews` on
`ReviewRecord.run_id` against `GET /pulls/:id/runs`; and **seeded** reviews
(`server/src/db/seed.ts`) carry `run_id: null`, so any run-filtered read
returns empty on seed data — test per-run paths only against a live run.

## 2026-08-17 — `check-contracts.sh` guards ONE of the two client mirrors; the feature-model registry is the other

**Rubric:** Codebase Patterns
**Symptom:** a one-line change to a `FEATURE_MODELS` default in
`server/src/vendor/shared/contracts/platform.ts`, synced with
`./scripts/check-contracts.sh --fix`, verified with a clean
`check-contracts: OK`, and typechecked in both packages — and the Settings screen
would still have offered the OLD default while the server used the new one. No
script, no typechecker and no test says a word.
**Cause:** the client cannot import a runtime VALUE from `@devdigest/shared` (it
breaks only the webpack build — see `client/insights.md` 2026-08-11), and
`FEATURE_MODELS` is a value, not a type. So `client/src/lib/feature-models.ts`
is a **second, hand-maintained copy** of the registry, and it lives *outside*
`client/src/vendor/`, which is the only tree `check-contracts.sh` rsyncs. The
guard's green checkmark is therefore true and irrelevant: it compared the two
`vendor/shared` trees, which did match.
**Fix:** treat a `FEATURE_MODELS` edit as **two** files in two packages, and diff
them by hand — the guard cannot help:

```sh
# rc=0 ⇒ in sync. Compares only the id/provider/model triples, normalising the
# quote style (the server file uses ', the client file uses ") and ignoring the
# comments and descriptions, which legitimately differ.
diff <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
         server/src/vendor/shared/contracts/platform.ts | tr -d "'\"") \
     <(grep -oE "(id|defaultProvider|defaultModel): *['\"][^'\"]+" \
         client/src/lib/feature-models.ts | tr -d "'\"")
```

Do **not** compare the two blocks with `grep -A<n>` — the server copy carries
comments the client copy does not, so the window slides and the diff is noise.
The same
trap applies to any other exported *value* the studio needs — a const array, an
enum-like object, a default table. Types are safe; values are a manual mirror
with no guard behind them. When adding one, put a pointer in both files.

## 2026-08-17 — there is no ESLint here; `lint:arch` is the only enforced architecture rule, and only on the server

**Rubric:** Codebase Patterns
**Symptom:** reviewing a client change against `client/AGENTS.md`, the natural
assumption is that *something* mechanical enforces at least the cheap rules — an
inline `queryKey` literal, a `fetch` inside a component, a hand-rolled primitive
that `src/vendor/ui` already has. Nothing does. `cd client && pnpm lint` is not a
script that exists, and its absence looks like an oversight rather than the whole
picture.
**Cause:** the repository has no ESLint at all — no `.eslintrc*` and no
`eslint.config.*` anywhere outside `node_modules`, and `client/package.json:5-11`
declares only `dev|build|start|typecheck|test`. The single architectural
enforcement in the repo is `server/package.json:11` →
`lint:arch` = `depcruise src --config .dependency-cruiser.cjs`: eleven named
rules (`no-drizzle-outside-persistence`, `no-db-schema-above-repository`,
`no-vendor-sdks-outside-adapters`, `no-fastify-below-routes`,
`no-cross-module-internals`, `no-module-imports-from-platform`,
`no-server-imports-from-shared`, `no-core-imports-from-server`, `no-circular`,
`not-to-dev-dep`, `no-deprecated-core` — `server/.dependency-cruiser.cjs:33-193`)
scanning `server/src` **only**.
**Fix:** treat the two halves as different jobs. On the server, run
`cd server && pnpm lint:arch` first and then never restate what it proved — quote
its result instead, or you spend the review re-deriving a rule that already
passed. On the client, every rule in `client/AGENTS.md` is prose held up by a
reader: an inline `queryKey`, `'use server'`, a locally-declared type instead of
`@devdigest/shared`, an edit to `src/vendor/shared/` alone — all of them compile,
all of them pass `pnpm test`, and nothing but review will catch them. One
server-side corollary: `.dependency-cruiser.cjs:23-26` records that "there is no
legacy allow-list left", so a **new** `pathNot` exemption is a regression of that
position and is a human decision, not a config tweak.

## 2026-08-17 — a subagent's startup git-status is a session-start snapshot, not the current tree

**Rubric:** What Doesn't Work
**Symptom:** a `plan-verifier` probe stated the working tree in its final message
— `A .claude/agents/researcher.md`, ` M server/src/modules/index.ts` — confidently
and in passing, having made **zero tool calls**. Four files that existed on disk
were missing from that picture and three more had been staged since. Nothing in
the output marked it as second-hand.
**Cause:** the harness injects a git-status snapshot into every subagent's startup
context, taken when the **session** began, and never refreshes it. An agent that
reads it as "the current state" is quoting inherited narrative, and inherited
narrative is indistinguishable from a checked fact once it is in the report.
**Fix:** any agent whose verdict depends on the tree must establish it itself —
`git status --porcelain`, `git diff`, `git diff --cached` — and treat the snapshot
as a hint, never as evidence. This is now a hard constraint in
`.claude/agents/plan-verifier.md` and `.claude/agents/architecture-reviewer.md`;
in particular, never mark a plan item `Not implemented` off a snapshot without
opening the path. The mirror-image trap shows up in long parallel runs: both
reviewers noticed files changing *mid-run* (a concurrent `test-writer` and
`doc-writer`), and the correct response is to record the shift in
`Coverage` / `Evidence log` rather than silently review a moving target. When
several write-agents run at once, expect `git status` to include work that is not
the one under review, and attribute it explicitly.

## 2026-08-17 — nothing in CI or vitest looks at `.claude/**`, and `wc -l` lies about the last line

**Rubric:** Tool & Library Notes
**Symptom:** five new agent definition files plus a rewritten
`.claude/agents/README.md` landed without a single check firing anywhere — no
workflow, no suite, no typechecker. Separately, a citation checker over those
files reported two *correct* `path:line` references as OUT OF RANGE.
**Cause:** two unrelated facts. (1) All six workflows in `.github/workflows/` are
path-filtered per package and none of them matches `.claude/**`;
`server/vitest.config.ts:14` includes only `test/**` and `src/**`, and
`client/vitest.config.ts:18` only `src/**`. A malformed agent frontmatter is
therefore invisible until somebody actually runs that agent. (2) `wc -l` counts
newline characters, not lines, so a file without a trailing newline reports one
fewer than it has — and a citation to that final line then fails a
`line <= wc -l` bound. `server/docs/README.md:31` and `client/docs/README.md:29`
are both exactly that case (`_(none yet)_` on the last line).
**Fix:** verify `.claude/**` by hand and assume no safety net. The checks worth
running: frontmatter parses and is closed; every key is in the set the existing
agents use (`name`, `description`, `tools`, `disallowedTools`, `model`, `effort`,
`permissionMode`, `color`); every tool name is real — a typo'd name is a silently
**empty** rule, so a denylist entry that does not resolve forbids nothing; `name`
equals the filename stem; every relative link passes `test -e`; every `path:line`
opens to what it claims. For that last check count lines with `grep -c ''` or
`awk 'END{print NR}'` (both count the trailing partial line) — verified: on a
3-line file with no final newline, `wc -l` says 2 while both alternatives say 3.

## 2026-08-12 — the skills' source scanner is now one file, and `<` in `PAIRS` was provably safe

**Rubric:** What Works
**Supersedes:** 2026-08-12 — angle-bracket slicing is safe only when anchored at a verified generic
**Symptom:** the two entries below describe the scanner as living in two places —
`.claude/skills/api-breaking-changes/surface.mjs` (no `<` in `PAIRS`) and
`.claude/skills/response-schema/lib.mjs` (with `<`). Both pointers are now stale:
`lib.mjs` is 19 lines of severity helpers and `surface.mjs` has no scanner at all.
An agent following either would go looking for a pairing table that is not there,
and could "restore" a second copy.
**Cause:** the copies were consolidated into
`.claude/skills/source-scan/scan.mjs`, the single owner of git-ref I/O
(`WORKTREE`/`listFiles`/`readAt`) and the scanner (`sliceBalanced`,
`stripComments`, `splitTopLevel`, `readExpression`, `lineAt`, `stringLiteral`).
`api-breaking-changes`, `api-response-changes` and `response-schema` all import
it; no skill reaches into another skill's internals any more.

The unification was safe for a reason worth keeping, because it looks dangerous
and is not: **`sliceBalanced` moves depth only on `c === open` or `c === close`,
where `open` is the character at the index you pass.** So adding `'<': '>'` to
`PAIRS` changes behaviour *only* for slices anchored directly at a `<`. Inside a
`(`, `{` or `[` slice, `<` was already an ordinary character in both copies and
`a < 5 && b > 3` could never unbalance anything. The `<`-aware table is therefore
a strict superset, which is why adopting it produced **byte-identical output**
from all six surface and check entry points across the three skills.
**Fix:** the call-site rule from the superseded entry still holds and now lives at
the top of `scan.mjs` and under "The angle-bracket rule" in
`.claude/skills/source-scan/SKILL.md` — anchor at a `<` only where a lookahead
has proved it opens a generic; for a fully wrapped generic use
`^Promise\s*<([\s\S]*)>$` instead of slicing. When changing the scanner, verify
with fixed invariants, not by reading a report — a scanner bug in a differential
tool shows up as a *missing* finding, not a crash:

```sh
node .claude/skills/api-breaking-changes/surface.mjs | grep -c '"method"'      # 101
node .claude/skills/response-schema/responses.mjs    | grep -c '"typeText"'    # 47
node .claude/skills/api-response-changes/response-surface.mjs --summary | wc -l # 53
```

Do not add a `legacy`/`strict` flag to `sliceBalanced` to restore an old
behaviour — two behaviours behind one name is how the copies drifted. Two callers
needing different semantics need two named functions. `pr-self-review/lib.mjs`
still keeps its own `git`/`matchesAny` (it is a changeset collector with no
scanner); that overlap is known and out of scope, not an oversight.

## 2026-08-12 — angle-bracket slicing is safe only when anchored at a verified generic

**Rubric:** What Works
**Supersedes:** 2026-08-12 — `sliceBalanced` in the skills' source scanner does not pair angle brackets
**Symptom:** none yet — latent. That entry's "adding `<`/`>` to `PAIRS` is not
the fix" reads as absolute, and `.claude/skills/response-schema/lib.mjs` does
exactly that. A reader reconciling the two could remove working code, or copy
the `PAIRS` change into a general-purpose scanner and hit the original bug.
**Cause:** the hazard is the *call site*, not the pairing table. `<` is
ambiguous only where it might be a comparison, JSX, or an arrow — that is,
where you scan arbitrary source. `extractCallerBindings` in
`.claude/skills/response-schema/responses.mjs` never scans arbitrary source: it
matches `/\bapi\s*\.\s*(get|post|…)\s*(?=<)/` and slices from the `<` that the
lookahead already proved opens a generic. Inside a type there is no comparison
operator and no JSX, so the only residual hazard is `=>`, which that
`sliceBalanced` steps over explicitly.
**Fix:** keep the original entry's rule as the default — do not reach for
`sliceBalanced` to pull a generic out of a service signature; `parseTypeExpr`'s
greedy match to the final `>` is right there. The one sanctioned exception is a
slice anchored at a position a lookahead has already proved is a generic open,
with `=>` skipped. Verified against nested generics (`Map<string, Set<number>>`),
an arrow inside a type literal (`Array<{ cb: (x: number) => boolean }>`), and a
bare `a < 5 && b > 3` (never matched); all 47 bindings extract correctly. If you
change that regex so it no longer proves the `<`, the exception is void — check
with `node .claude/skills/response-schema/responses.mjs | grep -c '"typeText"'`,
which must stay at 47.

## 2026-08-12 — `sliceBalanced` in the skills' source scanner does not pair angle brackets

**Rubric:** What Doesn't Work
**Symptom:** parsing `Promise<Agent[]>` out of a service signature yielded the
name `null` instead of `Agent`, with no error. Every endpoint in a new
`api-response-changes` surface resolved to an empty contract column while
`via: 'service-return'` still claimed success — a silent wrong answer, not a
crash.
**Cause:** `sliceBalanced` in `.claude/skills/api-breaking-changes/surface.mjs`
pairs brackets from `PAIRS = { '(':')', '{':'}', '[':']' }` only. Given `<` it
increments depth on the open character, never finds a close character (`PAIRS['<']`
is `undefined`), falls through to its truncation fallback, and returns *everything
after* the `<` — `Agent[]>`, trailing `>` included. The caller then tests
`/^(.*)\[\]$/`, which does not match because of that `>`, so the array unwrap and
the name extraction both fail quietly.
**Fix:** never use `sliceBalanced` on a TypeScript generic. For a fully-wrapped
generic, match greedily to the final `>` instead —
`new RegExp('^' + wrapper + '\\s*<([\\s\\S]*)>$')` — which is what
`parseTypeExpr` in `.claude/skills/api-response-changes/response-surface.mjs`
does. When a *nesting-aware* angle scan is genuinely needed (reading a return
annotation up to `=>`), count `<([{` / `>)]}` by hand and treat `=>` as the
terminator, as `readHandlerReturnType` in that file does. Adding `<`/`>` to
`PAIRS` is not the fix: `<` is ambiguous in TS/JS source (comparison, JSX, arrow
`=>`), and every existing caller scans `()`/`{}`/`[]` where the pairing is
unambiguous.

## 2026-08-11 — an OpenRouter `:free` model can drop `structured_outputs` while keeping `response_format`

**Rubric:** Tool & Library Notes
**Symptom:** the conventions scan failed with `429 Provider returned error` after
the workspace model was set to `google/gemma-4-31b-it:free`. The model id is
valid, the key works, and the paid `google/gemma-4-31b-it` is fine — so the 429
reads as a transient rate limit worth retrying. It is not the real problem.
**Cause:** two distinct facts wearing one error. (1) `429 Provider returned error`
is the *upstream* provider behind OpenRouter's free pool; OpenRouter's own quota
message reads `Rate limit exceeded: free-models-per-day`, so the wording tells you
which one you hit. (2) Behind it, `google/gemma-4-31b-it:free` advertises
`response_format` but **not** `structured_outputs` in its `supported_parameters`,
while the paid variant of the same model advertises both. Everything in this repo
that calls `completeStructured` sends
`response_format: {type:'json_schema', strict: true}`
(`reviewer-core/src/llm/openrouter.ts`), so that endpoint could never have
satisfied the scan — clearing the 429 would only have moved the failure.
**Fix:** check the capability before blaming the rate limit —

```sh
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    if 'gemma-4' in m['id']:
        print(m['id'], 'structured_outputs' in (m.get('supported_parameters') or []))"
```

`ModelCatalog.supportsStructuredOutputs` (`server/src/platform/model-catalog.ts`,
formerly `PriceBook` — it caches `/models` for prices *and* capabilities) now
answers this, and the conventions scan preflights on it and fails with
`reason: 'model_unsupported'` before spending a call. It returns **`boolean | null`**
and `null` means "the catalogue does not know" — callers must treat that as
*proceed*, never as a denial, or an unreachable `/models` blocks every scan. Free
models that DO work here: `google/gemma-4-26b-a4b-it:free`. When picking any new
free model for a structured-output feature, verify the flag first; `:free` is not
the same endpoint as its paid twin.

## 2026-08-11 — `check-contracts.sh --fix` also lands drift you did not create

**Rubric:** Codebase Patterns
**Symptom:** a one-file contract change (`contracts/knowledge.ts`) synced with
`./scripts/check-contracts.sh --fix` produced **five** modified files under
`client/src/vendor/shared/` — `adapters.ts`, `contracts/eval-ci.ts`,
`contracts/productionize.ts` and `contracts/trace.ts` had nothing to do with the
change.
**Cause:** the two trees were **already** out of sync before the change, and the
guard is one-directional by design (`rsync -a --delete`, server always wins). So
`--fix` does not sync your edit — it makes the whole mirror match canonical, which
includes every earlier unmirrored change. `git diff` on `main` had never been run
against `diff -r server/src/vendor/shared client/src/vendor/shared`, so nobody
knew. Both `tsc` runs pass either way, which is exactly the failure mode the guard
exists to surface.
**Fix:** run `diff -rq server/src/vendor/shared client/src/vendor/shared`
**before** touching a contract, so you know which files were already drifted and
can say so. Do not revert the extra files — they are the mirror catching up, and
reverting re-breaks it. Call them out separately in the PR description, and
re-typecheck the client afterwards: a client that stops compiling after a sync is
the real bug the guard found, not a sync problem.

## 2026-08-02 — the configured skills get skipped when repo patterns are easy to copy

**Rubric:** Session Notes
**Symptom:** a full-stack feature (contract → migration → repo → route → three
screens → tests) shipped without a single `Skill` invocation, even though this
repo configures skills that map directly onto every one of those steps. Nothing
broke; the work just didn't get the benefit.
**Cause:** each package's existing code answers "how do we do this here?" well
enough that copying the neighbouring pattern always feels sufficient, and no
step ever announces itself as the moment to reach for a skill.
**Fix:** the mapping worth remembering, since `CLAUDE.md` lists these per
package but not per task:

| Doing | Skill |
|---|---|
| touching `db/schema/**` or generating a migration | `drizzle-orm-patterns`, `postgresql-table-design` |
| editing `vendor/shared/contracts/**` | `zod` |
| a route/plugin under `src/modules/**` | `fastify-best-practices` |
| any `*.test.tsx` | `react-testing-library` |
| any component or hook | `react-best-practices`, `next-best-practices` |
| a chart | `dataviz` |

Copying the adjacent pattern reproduces whatever the adjacent pattern already
got wrong. The skill is the second opinion the repo can't give you.

## 2026-08-03 — a new field on `PrMeta` must be `.nullish()`, whatever it means

**Rubric:** Codebase Patterns
**Symptom:** adding a plainly-required field to `PrMeta`
(`vendor/shared/contracts/platform.ts`) breaks two call sites that have nothing
to do with the feature — the GitHub adapter stops typechecking, and the
`/pulls/:id` detail handler starts demanding a value it cannot compute.
**Cause:** `PrMeta` is triple-duty. It is (1) the list-row payload of
`GET /repos/:id/pulls`, (2) the return type of
`GitHubClient.listPullRequests()` (`vendor/shared/adapters.ts`), which maps
GitHub's PR-list JSON and knows nothing about our reviews, and (3) the base that
`PrDetail` extends, served by a handler that never runs the list's aggregate
queries. Anything computed from *our* tables therefore cannot be required.
`score` and `cost_usd` were already nullish for this reason, not only because
their values are semantically optional — and `findings` (the per-severity
counters, added 2026-08-03) joins them.
**Fix:** declare list-only fields `.nullish()` and comment them
`(list endpoint only)`, as the neighbours do. Then mirror the file into
`client/src/vendor/shared/contracts/platform.ts` — `cp` it, the two are meant to
stay byte-identical, and `diff -q` them before you finish. A `null` that means
"we never computed this here" is not the same fact as the domain's own null, so
resolve the display default at the UI (the findings cell renders a missing
breakdown as `0/0/0`; the score cell renders it as `—`), never in the contract.

## 2026-08-02 — LLM cost: `null` and `0` are different facts, keep them apart

**Rubric:** Codebase Patterns
**Symptom:** the obvious ways to render a run's dollar cost — `cost ?? 0`, or
`usd.toFixed(2)` — silently destroy information, and it isn't visible in
testing unless you happen to pick the right model.
**Cause:** two independent traps meet here. (1) `estimateCost`
(`server/src/adapters/llm/pricing.ts`) returns `null` for a model that isn't in
the table, but `z-ai/glm-4.7-flash` is listed at a real price of **0** — so
"free" and "unknown" are distinct states that both look falsy. (2) a chunked
review on a cheap OpenRouter model costs a fraction of a cent, so two decimal
places renders nearly every genuine run as `$0.00`. An earlier version of this
feature shipped with `toFixed(2)` and was useless for exactly that reason.
**Fix:** keep the column nullable end-to-end (`agent_runs.cost_usd` is
`double precision` NULL; `RunStats`/`RunSummary`/`PrMeta` carry
`cost_usd: number | null`) and never coalesce to 0. Format through
`client/src/lib/format-cost.ts`, which takes the placeholder as an argument
because only the call site knows whether `null` means "nothing ran yet" (`—`)
or "model not priced" (`n/a`). Precision follows magnitude: 2 dp at or above a
cent, 4 dp below, `<$0.0001` under that, and `$0.00` reserved for a true zero.
Same rule applies to the other `cost_usd` columns already declared for
eval/CI/observability.

## 2026-08-02 — bash `${1:?msg}` truncates at a `}` inside the message

**Rubric:** Tool & Library Notes
**Symptom:** a shell script whose only oddity was
`mode=${1:?usage: guard.sh {snapshot|verify} <file>}` printed
`line 13: file: No such file or directory` twice per run while otherwise
working — so the errors read as cosmetic and unrelated.
**Cause:** parameter expansion ends at the first unescaped `}`, which here is the
one inside `{snapshot|verify}`, not the one closing the expansion. The leftover
` <file>}` is then parsed as a redirect from a file literally named `file`.
**Fix:** keep `}` out of `${var:?…}` messages — use a `usage()` function plus an
explicit `[ $# -eq 2 ] || usage`. The same trap applies to `${var:-…}` and
`${var:+…}`.
