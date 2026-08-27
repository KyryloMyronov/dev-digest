# `reviewer-core/specs/` — intent for work not yet built

A spec is written **before** the code. Pipeline and API documentation lives in
[`../README.md`](../README.md).

**This folder holds the specs whose work is confined to `reviewer-core/`.** A
feature that also touches `server/`, `client/` or `mcp/` goes in the repo-root
[`specs/`](../../specs/README.md) folder instead — as does any change to a shared
Zod contract. The full routing table is in that README.

`SPEC-NN-slug.md`, with `NN` **globally unique across the repository** and
allocated as max existing + 1 over every spec folder at once. Every spec is
indexed once, in [`specs/README.md`](../../specs/README.md#index) — this file
keeps no second table.

Write one with the [`spec-creator`](../../.claude/agents/spec-creator.md) agent.
It runs in two passes: questions and design findings first, the file once you
have answered.

## Template

The section list and the writing rule for each section live in
[`.claude/skills/spec-creator/references/template.md`](../../.claude/skills/spec-creator/references/template.md),
mirrored for humans in [`specs/README.md`](../../specs/README.md#template). The
older engine-only template that used to sit here is superseded by it.

Two engine-specific things that template expects you to fill in:

- **Purity check** — does this need any I/O? If yes it does **not** belong in
  this package: name the caller-side piece (server module or CI runner) and what
  crosses the seam as a resolved value. State any new `ReviewInput` fields — they
  must be plain data, never handles or clients. This goes under *Module
  interactions*, and a spec here without it is not reviewable.
- **Grounding** — a new `Finding.kind` must say whether grounding treats it as
  diff-anchored or full-file, and acceptance criteria are asserted against a mock
  `LLMProvider`.

## Backlog — engine-side slices of the lesson roadmap

Roadmap source: [root `README.md`](../../README.md).

| Lesson | Engine-side work | Spec |
|---|---|---|
| L03 | Intent layer input · Smart Diff as a prompt slot | _not written_ |
| L06 | Secret / phantom gates · plan verifier | _not written_ |
| L07 | Multi-agent composition (reduce across agents, not just files) | _not written_ |

Every one of these must clear the **Purity check** section before any code is
written — that constraint is the reason this package can serve both the studio
and CI.