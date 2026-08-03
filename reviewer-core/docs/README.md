# `reviewer-core/docs/` — explanations

Index only. `CLAUDE.md` holds the *rules*; this folder holds the *why*, read on
demand. Nothing here should restate a README — link it instead.

## Already documented elsewhere (don't duplicate)

| Topic | Where |
|---|---|
| Pipeline stages, public API | [`../README.md`](../README.md) |
| Prompt slot order, required prompt conventions, severity/verdict/gate | [`../../docs/agent-prompts/README.md`](../../docs/agent-prompts/README.md) |
| Choosing a model | [`../../docs/agent-prompts/choosing-a-model.md`](../../docs/agent-prompts/choosing-a-model.md) |
| How the server consumes the engine | [`../../server/README.md`](../../server/README.md) |

## Add a doc here when

…an explanation is too long for `CLAUDE.md` and is about the engine's reasoning
rather than its usage. Candidates:

- `purity.md` — what the no-I/O rule buys, and the exact seam the server and CI runner share
- `grounding.md` — the citation gate's rules, the full-file exemption, and why score derives from survivors
- `injection.md` — the untrusted-content threat model and why the guard is central, not per-call
- `map-reduce.md` — when `auto` splits, how partials reduce, and the cost trade-off

Name files by topic, lowercase, one concern each.

## Docs in this folder

_(none yet)_