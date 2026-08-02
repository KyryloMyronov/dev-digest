# `e2e/docs/` — explanations and design notes

Index only. `CLAUDE.md` holds the *rules*; this folder holds the *why*.

**Note:** in this package `specs/` is the browser-flow folder, so anything
design-doc or intent shaped lives here instead — including specs for flows not
yet written.

## Already documented elsewhere (don't duplicate)

| Topic | Where |
|---|---|
| Flow file format, hermetic vs local runs, current coverage | [`../README.md`](../README.md) |
| Overall test strategy, why coverage is typological | [`../../TESTING.md`](../../TESTING.md) |
| The seeded fixtures flows assert against | `../../server/src/db/seed.ts` |

## Add a doc here when

…you need to record intent for a flow before writing it, or explain a decision
the flow files can't. Candidates:

- `flow-backlog.md` — user journeys worth covering, and which risk class each represents
- `determinism.md` — how flows stay LLM-free while testing an LLM product
- `ci.md` — how `e2e-web.yml` boots the stack and what makes it flake

## Docs in this folder

_(none yet)_