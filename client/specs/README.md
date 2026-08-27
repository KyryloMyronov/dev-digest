# `client/specs/` — intent for work not yet built

A spec is written **before** the code and describes what "done" means. Once the
feature ships, the spec stays as the record of intent; the UI route map lives in
[`../README.md`](../README.md).

**This folder holds the specs whose work is confined to `client/`.** A feature
that also touches `server/`, `reviewer-core/` or `mcp/` goes in the repo-root
[`specs/`](../../specs/README.md) folder instead — as does anything that changes
a shared Zod contract, since `client/src/vendor/shared/` is a hand-synced mirror
of the server's canonical copy. The full routing table is in that README.

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
older client-only template that used to sit here is superseded by it.

Two client-specific things that template expects you to fill in, and that a
client spec is wrong without:

- **API dependency** — which endpoints this needs and whether they exist yet,
  under *Module interactions*. A client spec must never invent a contract; if the
  endpoint does not exist, the feature is cross-module and the spec belongs in
  the root folder.
- **Every UI state** — loading · empty · partial · error · success, each with its
  own acceptance criterion. This is what the *Design review* pass exists to
  surface, and the most common thing a mockup leaves undrawn.

## Backlog — client-side slices of the lesson roadmap

Roadmap source: [root `README.md`](../../README.md).

| Lesson | Client-side work | Spec |
|---|---|---|
| L01 | Run cost badge · severity filter on findings | _not written_ |
| L02 | Skills UI in the product | _not written_ |
| L03 | Smart Diff view | _not written_ |
| L04 | Blast Radius visualisation | _not written_ |
| L05 | Onboarding generator · PR Brief card | _not written_ |
| L06 | Eval results · export-to-CI surface | _not written_ |
| L07 | Run Trace / Live Log · per-agent stats | _not written_ |
| L08 | Plugin export/import · agent performance dashboard · weekly digest | _not written_ |

Chart-bearing items (per-agent stats, performance dashboard, digest) should load
the `dataviz` skill before any chart code is written.