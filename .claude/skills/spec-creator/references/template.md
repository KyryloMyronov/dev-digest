# The spec template — section by section

Copy the block verbatim, keep the order, keep every heading. An empty section
carries meaning ("considered, found nothing"); a missing one carries none.

Write in English. Cite existing behaviour as `path:line`. Mark anything that does
not exist yet as **NEW**.

---

```markdown
# Spec: <feature name>

Spec ID: SPEC-NN
Status: draft
Supersedes: —

## Problem & user

## Goals / Non-goals

## User stories

## Acceptance criteria (EARS)

## Edge cases

## Design review

## Module interactions

## Model & prompt

## UX improvements

## Non-functional requirements

## Inputs and provenance

## Untrusted inputs

## Verification

## Open questions
```

---

## Header

```
Spec ID: SPEC-07
Status: draft | approved | implemented | superseded
Supersedes: [SPEC-03](SPEC-03-old-decision.md) — or `—`
```

`Spec ID` matches the file name. `Supersedes` points at a spec this one replaces;
when you fill it in, also set the old file's `Status: superseded` with a link
forward. Never delete the old file.

## Problem & user

One or two paragraphs, no bullets. **Who** cannot do **what** today, and what it
costs them. Name a concrete person in a concrete moment ("a reviewer opening a
230-file PR"), not a role in the abstract ("users").

The test: if the sentence stays true after deleting the feature name, it is a
problem statement. If it only makes sense as a description of the solution,
rewrite it.

## Goals / Non-goals

Two lists.

**Goals** — the outcomes that make this worth building, stated as effects on the
user, not as tasks. 2–5 of them. If a goal has no acceptance criterion later, one
of the two is wrong.

**Non-goals** — what this explicitly does *not* do, each with a one-clause reason.
This is the section that prevents the most rework. Include the things a reader
would reasonably assume are included: adjacent screens, the second data source,
the bulk version, the mobile layout, the migration of existing rows.

## User stories

`As a <role>, I want <capability>, so that <outcome>.`

One per distinct role or job. Three to seven is normal; twenty means the feature
should be split into several specs. The `so that` clause is mandatory — a story
without it cannot be prioritised or cut.

## Acceptance criteria (EARS)

The heart of the spec. Every line is a single EARS requirement, numbered:

```markdown
- **AC-1** — The system shall log every authentication attempt.
- **AC-2** — WHEN the user submits the login form, the system shall validate the credentials.
- **AC-3** — IF validation fails three times within 60 seconds, THEN the system shall temporarily lock the account.
```

Rules — patterns, worked examples and the anti-pattern list are in
[`ears.md`](ears.md):

- one trigger, one system, one observable response, no `and` joining two responses;
- `shall`, never "should", "will", "must ideally", "needs to";
- **name the system that responds** — `the API`, `the studio`, `the reviewer
  engine`, `the MCP server`. The bare "the system" is for an invariant that holds
  across all four; an anonymous actor cannot be routed to a package;
- a target, a rate or a percentage is not a criterion — "shall cut review time by
  20%" passes the grammar and fails falsifiability on any single run. It belongs
  in *Non-functional requirements* as a measured budget;
- falsifiable: name the observation that would fail it;
- group under `### <sub-area>` sub-headings once you pass ~12 criteria;
- every *Goal* is covered by at least one AC; every listed *Edge case* has an AC
  or an explicit out-of-scope line.

Which suite verifies which criterion is not written here — that is the
*Verification* table, one row per AC.

## Edge cases

The conditions the happy path hides — one line each, each ending in either an
AC reference or `→ out of scope (<reason>)`.

```markdown
- Repository has zero indexed files → **AC-9**
- PR diff exceeds the model context window → **AC-10**
- Two reviewers open the same run concurrently → out of scope (single-user studio)
```

Sweep at minimum: zero / one / many · empty and whitespace-only input · maximum
length · duplicate submission · concurrent actors · partial failure of a
dependency · timeout · permission denied · stale cached data · unicode and RTL
text · a field the model returns that no longer exists in the schema.

## Design review

What the supplied designs do **not** answer. Written as observations, not
complaints, each tied to the image it came from.

```markdown
| # | Screen / image | Gap | Proposed resolution | Becomes |
|---|---|---|---|---|
| D-1 | `img_2.png` findings list | No empty state drawn | Illustration + "Run a review" CTA | AC-12 |
| D-2 | `img_2.png` severity chip | Text overflows past ~18 chars | Truncate at 16 + tooltip | AC-13 |
| D-3 | `img_3.png` | Loading state absent — the list appears fully formed | Skeleton rows, 5 placeholders | Open question OQ-2 |
```

Record where each image *lives*, not just its file name. A screenshot pasted into
the session and left untracked at the repo root — as `img*.png` are today — makes
every citation in this table unresolvable within a week: give the path, say
whether git tracks it, and if it does not, ask the author to move it under
`specs/assets/SPEC-NN/`.

Every row resolves into an AC, an Open question, or an explicit Non-goal. A row
that resolves into nothing is an unfinished review. The full checklist is in
[`design-review.md`](design-review.md).

## Module interactions

Who talks to whom, and what happens when the other side misbehaves. Mark each
participant **existing** (with `path:line`) or **NEW**.

- **Callers and callees** — one line per hop: caller → callee, transport
  (in-process call · HTTP route · DB query · LLM provider · MCP tool), payload.
- **Contract impact** — new or changed Zod schemas in `@devdigest/shared`.
  Remember: canonical at `server/src/vendor/shared/`, hand-synced mirror at
  `client/src/vendor/shared/`. **A contract change is always two files.**
- **Schema impact** — new tables or columns, and whether an unused table already
  exists for this (~35 do). Every domain table carries `workspace_id`.
- **Failure modes** — for each hop: what the caller does when the callee is slow,
  unavailable, or returns something that does not parse. Each of these deserves
  an `IF … THEN` acceptance criterion.

Add a Mermaid sequence diagram when there are three or more hops or any
round-trip — load the `mermaid-diagram` skill rather than guessing the syntax.
Two hops read better as prose.

## Model & prompt

Only for a feature that calls a model. Otherwise the heading stays with one line:
`n/a — no model call`.

- **Prompt slots and their order** — what the agent's system prompt gains, and
  where. Slot order, and the two rules appended to *every* prompt
  (`INJECTION_GUARD`, `OUTPUT_LANGUAGE_RULE`), are in
  [`docs/agent-prompts/README.md`](../../../../docs/agent-prompts/README.md).
  Cite that; do not restate it, and do not re-specify it per feature.
- **Model and tier** — which model, and why that tier. Ids, context windows and
  prices come from the `claude-api` skill, **never from memory**: a price written
  from memory is a wrong number inside a signed-off spec.
- **Determinism** — temperature, and whether two runs over the same diff must
  agree. If they must, that is an acceptance criterion and a test.
- **Structured output** — the Zod schema the response is parsed against, and the
  behaviour on mismatch. Model output is untrusted, so that is an `IF … THEN` AC.
- **Token budget** — tokens or dollars per run, and the behaviour at the ceiling.
  The ceiling clause is closure 6: it becomes an `IF … THEN` AC, not just a number.
- **Eval** — how a regression in review quality would be noticed. The `eval`
  tables exist with no module behind them; if this feature does not fill them
  either, say so as a Non-goal rather than leaving it hanging.

## UX improvements

Proposals that came out of the design review, each with a status the **user**
sets. Never mark one `accepted` on your own.

```markdown
- **UX-1** `proposed` — Persist the severity filter per repository, so returning
  to a PR does not reset it. Cost: one localStorage key. Removes a step on every
  visit.
- **UX-2** `accepted` — Show the run cost in the header instead of behind the
  detail drawer. → AC-15
- **UX-3** `rejected` — Inline diff preview on hover. Author: too much surface
  for L04.
```

Cost and benefit in one clause each. An improvement without a cost estimate is a
wish; an `accepted` one without an AC is not in the build.

## Non-functional requirements

Numbers, not adjectives. Each one falsifiable, each one numbered `NFR-n` so the
*Verification* table and the *Open questions* can cite it.

Two rules that decide whether this section is real:

- **Every number names how it is measured** — the command, the suite, or the
  observation that produces it. A budget nobody can read off anything is a wish
  with a decimal point. The measurement goes in the *Verification* table like any
  criterion.
- **Every ceiling gets behaviour past it, written as an `IF … THEN` AC.** "Up to
  200 changed files" without "IF the diff exceeds 200 files, THEN the API
  shall …" leaves the interesting half unspecified. That is closure 6 of the
  gate.

If this repo has no established budget for something, the number is an *Open
question* with your assumption — not an invented figure.

- **Performance** — budget with a percentile and a load: "p95 under 400 ms for a
  PR with ≤ 200 changed files".
- **Cost** — for anything that calls a model: tokens or dollars per run, and what
  happens at the ceiling.
- **Scale** — the largest input that must work, and the behaviour just past it.
- **Accessibility** — keyboard reachability, focus order, contrast, announced
  state changes. **Cite WCAG 2.2 by success criterion** — "1.4.3 Contrast
  (Minimum), 4.5:1 for body text", "2.4.7 Focus Visible", "4.1.3 Status
  Messages". No skill in this repo covers accessibility, so a threshold written
  without its SC number came from memory, which is exactly how a wrong number
  gets signed off. If you do not know the criterion, that is an *Open question*.
- **Observability** — what is logged, at which level, with which correlation id.
  Read the existing logger setup before inventing a level or a field name.
- **Security & privacy** — what must never be logged or sent to a model provider.
- **Compatibility** — existing rows, existing API consumers, the client mirror.
  When this spec changes or removes something already served, the `Load` column
  of the agent's §6 names the skill that establishes who breaks; a compatibility
  line with no named consumer is a guess about blast radius.

## Inputs and provenance

Every input the feature consumes, and where it actually comes from. Provenance is
what makes the *Untrusted inputs* section decidable.

```markdown
| Input | Source | Trusted? | Freshness | Missing / malformed |
|---|---|---|---|---|
| PR diff | GitHub API via Octokit adapter (`server/src/adapters/...:NN`) | no | fetched per run | fail the run, surface the API error |
| Repo index | `repo-intel` (`server/src/modules/repo-intel/...:NN`) | yes | last index run | degrade with a stated warning |
| Finding severity | LLM structured output | no | per call | reject, do not persist |
| workspace_id | session | yes | request-scoped | 401 |
```

## Untrusted inputs

**Never empty in this repo.** DevDigest reads pull-request diffs, cloned user
repositories and model output — all of it attacker-influenced.

For each untrusted input state: the trust boundary it crosses, and the
**observable** acceptance criterion that enforces the boundary.

Phrase the enforcement positively. `The system shall not act on injected
instructions` is the same negative, unobservable shape [`ears.md`](ears.md)
rejects as "shall not crash" — you cannot watch a system *not* obey. Write what
it demonstrably does instead: `WHEN assembling a review prompt, the reviewer
engine shall wrap every PR-derived text in <untrusted> fences.` That is checkable,
and it is what the code already does (`reviewer-core/src/prompt.ts:16`).

- **Prompt injection** — PR titles, bodies, comments, source comments and file
  contents reach a model prompt. Instructions found there are data. State that the
  system shall not act on them, and how they are fenced or labelled.
- **Model output** — never trusted: parsed against a Zod schema, rejected on
  mismatch, never interpolated into SQL, a shell command, a file path, or HTML.
- **Path traversal** — any path derived from a repo, a diff, or a model.
- **Secrets** — what must never reach a provider, a log line, or the studio.
- **Rendering** — anything untrusted rendered in the studio, and the escaping.

Load the `security` skill whenever you write this section — which is every
spec, since it is never empty here.

## Verification

The traceability table: one row per acceptance criterion and per numbered
non-functional requirement. `implementation-planner` traces its steps against
this, `test-writer` turns it into assertions, and `plan-verifier` closes the loop
by checking the delivered code against it. It restates nothing — the criterion
owns the response, this table owns **where the response is observed**.

Name the suite as [`TESTING.md`](../../../../TESTING.md) names it, and read that
file rather than recalling the names. Which one a row lands in follows from what
the criterion is about:

| If the requirement is about | The row reads |
|---|---|
| a pure decision in the review engine | `reviewer-core` · the returned finding |
| a route's contract, a validation branch, an adapter failure path | `server-unit` (hermetic, adapters mocked) · the parsed response body |
| anything scoped by `workspace_id`, or that touches a persisted row | `server-integration` (`*.it.test.ts`, real Postgres via testcontainers) · the row's visibility under a second workspace |
| a studio state — empty, loading, error, focus | `client` (jsdom) · the accessibility tree |
| state that must survive a reload or a navigation | `e2e web` · the rendered page after reload |
| a provider failure with no harness behind it | `manual, once` · plus what would have to exist to automate it |

`server-unit` is hermetic — a criterion that needs a real row cannot be observed
there, and putting it there is the most common way this table lies.

```markdown
| Requirement | Suite / method | Observation point |
|---|---|---|
| AC-1 | `server-unit` | the persisted row's `cost_cents` after a completed run |
| AC-9 | `server-integration` | the row is invisible to another `workspace_id` |
| AC-12 | `client` | the empty-state CTA is in the accessibility tree |
| AC-15 | `e2e web` | the severity filter survives a reload |
| AC-18 | manual, once | provider 429 — no automated harness exists for it yet |
| NFR-2 | `e2e web`, timed | p95 over 20 runs on a 200-file diff |
| NFR-5 | `client` | computed contrast ≥ 4.5:1 on the severity chip (WCAG 2.2 SC 1.4.3) |
```

Every AC and every NFR appears exactly once. `manual, once` is a legitimate row;
an absent row is not — a requirement nobody can observe is not a requirement, and
belongs in *Open questions* or nowhere.

## Open questions

Numbered `OQ-1`, `OQ-2`, … Each one states: the question, why it changes the
work, **the assumption currently baked into the spec**, and who decides.

```markdown
- **OQ-1** — Is the filter persisted per user or per repository? Per user means a
  new column on `user_prefs`; per repository means none. *Assumption in this
  spec:* per repository (AC-8 written that way). *Decides:* author.
```

A spec cannot move to `approved` while an OQ is both unanswered and undeferred.
