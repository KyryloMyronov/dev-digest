# `specs/` — Spec-Driven Development

**This folder holds the specs that cross more than one package.** A feature that
touches `server/` and `client/` at once is one feature; splitting it across two
folders would be read as two. A spec that changes exactly one package lives in
that package's own `specs/` folder instead — the routing rule and the single
global index are below.

A spec is written **before** the code and defines what "done" means. After the
feature ships the spec stays as the record of *intent* — behaviour documentation
belongs in the package `README.md` / `docs/`.

Specs are written by the [`spec-creator`](../.claude/agents/spec-creator.md)
agent, with the feature description and any design screenshots. It runs in **two
passes**: the first reads the code, reviews the designs and comes back with
questions and proposals without writing anything; the second, once you have
answered, writes the file. Answer its questions rather than pre-empting them —
that round trip is the whole point of the agent.

Its write scope is enforced, not merely instructed: a `PreToolUse` hook
([`.claude/hooks/spec-creator-guard.py`](../.claude/hooks/spec-creator-guard.py))
refuses any path outside the spec folders, scoped by `agent_type` so no other
agent is affected.

The plan built *from* a spec is a separate artifact in
[`plans/`](plans/README.md) — same folder tree, different contract: the spec says
what and why, the plan says how, in what order and how it is proven.

## Where a spec goes

| The feature changes | Folder |
|---|---|
| more than one package | `specs/` — here |
| a shared Zod contract | `specs/` — canonical at `server/src/vendor/shared/`, mirrored in `client/`, so it is always two packages |
| `server/` only | [`server/specs/`](../server/specs/README.md) |
| `client/` only | [`client/specs/`](../client/specs/README.md) |
| `reviewer-core/` only | [`reviewer-core/specs/`](../reviewer-core/specs/README.md) |
| `mcp/` only | [`mcp/specs/`](../mcp/specs/README.md) |
| unclear | here, with the reason stated — a stray single-module spec is untidy; a split cross-module spec is wrong |

`e2e/specs/` is **not** a spec folder in this sense: it holds `.flow.json`
browser flows.

## Index

Every spec in the repo, whichever folder holds it. This is the only index —
package `specs/README.md` files describe their folder and point back here rather
than keeping a second table that drifts.

| Spec | Feature | Status | Where | Implements |
|---|---|---|---|---|
| [SPEC-01](SPEC-01-project-context.md) | Project Context — discover repo Markdown, attach it to agents and skills, inject it into the prompt | `implemented` | `specs/` | L05 |

## Naming and numbering

`SPEC-NN-kebab-slug.md` — `NN` zero-padded, **globally unique across the whole
repository**, allocated as max existing + 1, never reused. A number identifies a
spec on its own: in a plan filename, in a commit message, in a PR, without also
naming the folder.

```sh
git ls-files | grep -oE 'SPEC-[0-9]+' | sort -V -u | tail -1
```

No output means no numbered spec exists yet — the first one is `SPEC-01`.
`git ls-files` sees every tracked spec wherever it sits, so a new package's
`specs/` folder cannot fall outside the scan; `sort -V` keeps `SPEC-100` above
`SPEC-99`. `NN` is two digits and widens to three past 99.

`plans/` does not take part in that allocation — a plan reuses its spec's number
rather than claiming one. Neither do the older free-form files in
`server/specs/` (`run-cost.md`, `skills.md`, `conventions.md`): they predate the
numbering and are not renumbered.

## Status lifecycle

| Status | Means |
|---|---|
| `draft` | *Open questions* are still open. Do not build from it. |
| `approved` | Every open question is answered or explicitly deferred. An implementer may start. |
| `implemented` | Shipped; link the PR. The file stays as the record of intent. |
| `superseded` | A newer spec replaced it. Link forward; keep the file. |
| `rejected` | The author decided against building it. Keep the file and its number; state the reason under the header. |

Only the author promotes a spec past `draft`. A number is never reused —
`rejected` and `superseded` specs keep theirs forever.

## Plans

| | |
|---|---|
| Folder | [`plans/`](plans/README.md) |
| File | `SPEC-NN-<spec-slug>.plan.md`, or `TASK-<slug>.plan.md` with no spec behind it |
| Written by | the **main session**, after the author approves the plan — never by a subagent |
| Read by | `implementer` (its contract), `plan-verifier` (its checklist) |

A plan lives on disk because `implementer` usually runs in a fresh session and
`plan-verifier` will not verify without the plan it was approved against. Naming,
the metadata header, the status lifecycle and how a plan is amended mid-build:
[`plans/README.md`](plans/README.md).

## Template

Section-by-section writing rules — what belongs in each, and what disqualifies a
line — live in
[`.claude/skills/spec-creator/references/template.md`](../.claude/skills/spec-creator/references/template.md).
The two must not drift: change one, change both.

```markdown
# Spec: <feature name>

Spec ID: SPEC-NN
Status: draft
Supersedes: —

## Problem & user
Who cannot do what today, and what it costs them. No solution here.

## Goals / Non-goals
Goals as outcomes, not tasks. Non-goals with a reason each — this is the section
that prevents the most rework.

## User stories
As a <role>, I want <capability>, so that <outcome>.

## Acceptance criteria (EARS)
Numbered AC-n, one EARS requirement each. Full guide: **EARS in one screen** below.
- **AC-1** — The system shall log every authentication attempt.
- **AC-2** — WHEN the user submits the login form, the system shall validate the credentials.
- **AC-3** — IF validation fails three times within 60 seconds, THEN the system shall temporarily lock the account.

## Edge cases
One line each, every one ending in an AC reference or `out of scope (<reason>)`.

## Design review
Table of what the supplied designs do not answer, and how each gap resolves.

## Module interactions
Who calls whom, with what payload, and what happens when the other side is slow,
absent, or wrong. Contract impact (both `vendor/shared/` copies) and schema
impact go here.

## Model & prompt
For a feature that calls a model: prompt slots, model and tier, determinism, the
schema its output is parsed against, the token budget and the behaviour at the
ceiling. `n/a — no model call` otherwise.

## UX improvements
Proposals from the design review, each `proposed` | `accepted` | `rejected`,
with a cost clause. Only the author accepts one.

## Non-functional requirements
Numbers, not adjectives: performance, run cost, scale, accessibility,
observability, security, compatibility. Numbered `NFR-n`; each names how it is
measured, and every ceiling has an `IF … THEN` criterion for what happens past it.
Accessibility numbers cite WCAG 2.2 by success criterion, never from memory.

## Inputs and provenance
Table: input · source · trusted? · freshness · behaviour when missing or malformed.

## Untrusted inputs
Never empty here — DevDigest reads PR diffs, cloned repos and model output.
Per input: the trust boundary and the **observable** AC that enforces it — a
fence, a parse, a rejection. Never `shall not`.

## Verification
The traceability table: one row per AC and per NFR — which suite observes it, and
where. Nothing restated from the requirement itself. Suites are named as
[`TESTING.md`](../TESTING.md) names them: `client`, `server-unit`,
`server-integration`, `reviewer-core`, `e2e web`.

## Open questions
Numbered OQ-n, each with the assumption currently baked into the spec and who
decides. A spec cannot reach `approved` with an unanswered, undeferred OQ.
```

## EARS in one screen

| Pattern | Shape |
|---|---|
| Ubiquitous | The system **shall** `<response>`. |
| Event-driven | **WHEN** `<trigger>`, the system **shall** `<response>`. |
| State-driven | **WHILE** `<state>`, the system **shall** `<response>`. |
| Unwanted behaviour | **IF** `<condition>`, **THEN** the system **shall** `<response>`. |
| Optional feature | **WHERE** `<feature enabled>`, the system **shall** `<response>`. |

One trigger, one **named** system (`the API`, `the studio`, `the reviewer
engine`, `the MCP server`), one observable response, `shall` and nothing weaker.
Two patterns may nest — upstream calls that a *complex* requirement. Full guide,
the naming rule, the six coverage closures and the anti-pattern table:
[`.claude/skills/spec-creator/references/ears.md`](../.claude/skills/spec-creator/references/ears.md).

EARS is Mavin, Wilkinson, Harwood & Novak, *Easy Approach to Requirements
Syntax*, IEEE RE'09 (2009).

## Per-package spec folders

`server/specs/`, `client/specs/`, `reviewer-core/specs/` and `mcp/specs/` hold
the specs that change exactly one package, written to the same template and
numbered from the same global sequence. `server/specs/` also still holds the
older free-form files (`conventions.md`, `run-cost.md`, `skills.md`) and each
package's lesson-roadmap backlog table; those stay as they are.

The package-specific concerns those folders mandate belong in the sections above,
wherever the spec lives:

- **`reviewer-core`** — a *Purity check*: if the feature needs I/O it does not
  belong in that package. State it under *Module interactions*.
- **`client`** — the API dependency, and whether the endpoint exists yet. A
  client spec must never invent a contract.
- **`server`** — contract changes land in **both** `vendor/shared/` copies (which
  makes them cross-module), and ~35 tables already exist unused. Check before
  asking for a new one.
- **`mcp`** — which REST endpoint the tool fronts, and what it does when the API
  is unreachable.
