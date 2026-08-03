# `server/docs/` — explanations

Index only. `CLAUDE.md` holds the *rules*; this folder holds the *why*, read on
demand. Nothing here should restate a README — link it instead.

## Already documented elsewhere (don't duplicate)

| Topic | Where |
|---|---|
| Request & DI flow, API map, environment variables, review context | [`../README.md`](../README.md) |
| Indexer pipeline, `RepoIntel` facade, routes | [`../src/modules/repo-intel/README.md`](../src/modules/repo-intel/README.md) |
| Unit/integration split, suite map | [`../../TESTING.md`](../../TESTING.md) |
| Prompt slot order, output conventions | [`../../docs/agent-prompts/README.md`](../../docs/agent-prompts/README.md) |
| Architecture overview + diagram | [`../../README.md`](../../README.md) |

## Add a doc here when

…an explanation is too long for `CLAUDE.md` (which must stay under ~70 lines)
and doesn't belong in a README because it's about *reasoning*, not usage.
Candidates as the codebase grows:

- `adapters.md` — how to add an adapter and why the interface lives in `shared`
- `jobs.md` — JobRunner semantics: timeouts, retry/backoff, the `jobs` table
- `sse.md` — the replay-first run bus, and why cancellation flows through it
- `tenancy.md` — the `workspace_id` guard and what breaks without it

Name files by topic, lowercase, one concern each. Add a row to the table below.

## Docs in this folder

_(none yet)_