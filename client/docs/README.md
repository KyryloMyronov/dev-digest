# `client/docs/` — explanations

Index only. `CLAUDE.md` holds the *rules*; this folder holds the *why*, read on
demand. Nothing here should restate a README — link it instead.

## Already documented elsewhere (don't duplicate)

| Topic | Where |
|---|---|
| UI route map | [`../README.md`](../README.md) |
| Design system: kit, primitives, charts, shell | [`../src/vendor/ui/README.md`](../src/vendor/ui/README.md) |
| Client test setup and conventions | [`../../TESTING.md`](../../TESTING.md) |
| API surface the client consumes | [`../../server/README.md`](../../server/README.md) |

## Add a doc here when

…an explanation is too long for `CLAUDE.md` and isn't usage documentation.
Candidates as the UI grows:

- `data-layer.md` — query keys, invalidation rules, why every call goes through `lib/api.ts`
- `error-ux.md` — the toast / inline / full-screen taxonomy and how `ApiError.status` selects one
- `live-runs.md` — consuming the SSE run stream, reconnection, replay
- `i18n.md` — next-intl catalogue layout and adding a locale

Name files by topic, lowercase, one concern each.

## Docs in this folder

_(none yet)_