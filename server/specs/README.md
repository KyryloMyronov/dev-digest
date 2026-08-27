# `server/specs/` — specs that change this package only

A spec is written **before** the code and describes what "done" means. Once the
feature ships, the spec stays as the record of intent; behaviour documentation
belongs in [`../README.md`](../README.md) or [`../docs/`](../docs/README.md).

**This folder holds the specs whose work is confined to `server/`.** A feature
that also touches `client/`, `reviewer-core/` or `mcp/` goes in the repo-root
[`specs/`](../../specs/README.md) folder instead — and a change to a shared Zod
contract always does, because the canonical copy here is mirrored into
`client/src/vendor/shared/`. The full routing table is in that README.

Naming and numbering come from the root folder too: `SPEC-NN-slug.md`, with `NN`
**globally unique across the repository** and allocated as max existing + 1 over
every spec folder at once. Every spec is indexed once, in
[`specs/README.md`](../../specs/README.md#index) — this file keeps no second
table.

Write one with the [`spec-creator`](../../.claude/agents/spec-creator.md) agent.
It runs in two passes: questions and design findings first, the file once you
have answered. The section list it writes to is
[`.claude/skills/spec-creator/references/template.md`](../../.claude/skills/spec-creator/references/template.md).

The older free-form files already here (`conventions.md`, `run-cost.md`,
`skills.md`) predate both the template and the numbering. They stay as they are —
they are shipped specs, and rewriting them would lose the record of intent — and
they do not take part in the number allocation.

Server-specific points the root template expects you to fill in:

- **Contract changes** belong under *Module interactions* — new or changed Zod
  schemas in `@devdigest/shared`, canonical at `server/src/vendor/shared/` with a
  hand-synced mirror at `client/src/vendor/shared/`. A contract change is always
  two files.
- **Schema changes** belong there too — the migration name once generated. Many
  tables already exist unused (see root `AGENTS.md`); check before adding one.

## Backlog — server-side slices of the lesson roadmap

Roadmap source: [root `README.md`](../../README.md). One spec per row, written
when the lesson starts.

| Lesson | Server-side work | Spec |
|---|---|---|
| L02 | Skills in the product | [`skills.md`](skills.md) |
| L02 | Conventions extractor | [`conventions.md`](conventions.md) |
| L03 | ~~Intent layer~~ (shipped — see [`../README.md`](../README.md#review-context-non-obvious)) · Smart Diff | _not written_ |
| L04 | `devdigest-mcp` server · Blast Radius (reads `repo-intel`) | _not written_ |
| L05 | Project Context Folder · onboarding generator · PR Brief | _not written_ |
| L06 | Eval pipeline · secret/phantom gates · plan verifier · export to CI | _not written_ |
| L07 | Multi-agent review · run trace/live log · persistent memory · per-agent stats | _not written_ |
| L08 | Plugin export/import · agent performance dashboard · weekly digest | _not written_ |

Most of these already have tables in the schema and contracts in
`@devdigest/shared` — read those first; the spec's job is the module and the
routes, not the data model.