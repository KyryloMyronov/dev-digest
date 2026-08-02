# `server/specs/` — intent for work not yet built

A spec is written **before** the code and describes what "done" means. Once the
feature ships, the spec stays as the record of intent; behaviour documentation
belongs in [`../README.md`](../README.md) or [`../docs/`](../docs/README.md).

File naming: `LNN-slug.md` for roadmap lessons, `slug.md` otherwise.

## Template

```markdown
# <Feature>

**Status:** draft | agreed | building | shipped
**Lesson:** L0N (or —)

## Problem
One paragraph. What can't be done today, and who cares.

## Scope
- Bullet list of what this change includes.

## Out of scope
- Explicitly what it does NOT include. This section prevents the most rework.

## Contract changes
New or changed Zod schemas in `@devdigest/shared` — remember the client mirror.
New or changed routes, with method + path + request/response shape.

## Schema changes
New tables/columns, and the migration name once generated. Note: many tables
already exist unused (see root CLAUDE.md) — check before adding one.

## Acceptance criteria
- [ ] Observable, testable statements. Not "works correctly".
- [ ] Which suite covers each: unit / `*.it.test.ts` / e2e flow.

## Open questions
Anything that would change the design if answered differently.
```

## Backlog — server-side slices of the lesson roadmap

Roadmap source: [root `README.md`](../../README.md). One spec per row, written
when the lesson starts.

| Lesson | Server-side work | Spec |
|---|---|---|
| L02 | Skills in the product · conventions extractor | _not written_ |
| L03 | Intent layer · Smart Diff | _not written_ |
| L04 | `devdigest-mcp` server · Blast Radius (reads `repo-intel`) | _not written_ |
| L05 | Project Context Folder · onboarding generator · PR Brief | _not written_ |
| L06 | Eval pipeline · secret/phantom gates · plan verifier · export to CI | _not written_ |
| L07 | Multi-agent review · run trace/live log · persistent memory · per-agent stats | _not written_ |
| L08 | Plugin export/import · agent performance dashboard · weekly digest | _not written_ |

Most of these already have tables in the schema and contracts in
`@devdigest/shared` — read those first; the spec's job is the module and the
routes, not the data model.