# `reviewer-core/specs/` — intent for work not yet built

A spec is written **before** the code. Pipeline and API documentation lives in
[`../README.md`](../README.md).

File naming: `LNN-slug.md` for roadmap lessons, `slug.md` otherwise.

## Template

```markdown
# <Feature>

**Status:** draft | agreed | building | shipped
**Lesson:** L0N (or —)

## Problem
What the engine can't express or detect today.

## Scope
- Which pipeline stage changes: prompt · structured output · reduce · grounding · output.

## Out of scope
- Explicitly excluded.

## Purity check  ← MANDATORY SECTION
Does this need any I/O? If yes, it does NOT belong in this package: name the
caller-side piece (server module or CI runner) and what crosses the seam as a
resolved value. State the new `ReviewInput` fields, if any — they must be plain
data, never handles or clients.

## Contract changes
New/changed schemas in `@devdigest/shared` (both copies). New `Finding.kind`
values must state whether grounding treats them as diff-anchored or full-file.

## Acceptance criteria
- [ ] Observable statements, asserted with a mock `LLMProvider`.
- [ ] Grounding behaviour stated explicitly if findings are involved.

## Open questions
```

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