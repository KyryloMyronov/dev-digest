# `client/specs/` — intent for work not yet built

A spec is written **before** the code and describes what "done" means. Once the
feature ships, the spec stays as the record of intent; the UI route map lives in
[`../README.md`](../README.md).

File naming: `LNN-slug.md` for roadmap lessons, `slug.md` otherwise.

## Template

```markdown
# <Feature>

**Status:** draft | agreed | building | shipped
**Lesson:** L0N (or —)

## Problem
What the user can't see or do today.

## Scope
- Which route(s) change, which components are new.

## Out of scope
- Explicitly excluded. Prevents the most rework.

## API dependency
Which endpoints this needs, and whether they exist yet. If not, link the
server-side spec — the client spec must not invent a contract.

## UI
Route path, where it hangs off the app shell, and the states that must be
designed: loading · empty · error (toast/inline/full-screen) · success.
Data comes via a hook in `lib/hooks/` — name it here.

## Acceptance criteria
- [ ] Observable statements a test can assert.
- [ ] Which suite covers each: vitest+jsdom / e2e flow.

## Open questions
```

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