# The studio data layer

For anyone adding or changing a screen's server access. This page explains *why*
the layer is shaped the way it is and what breaks when you step outside it. For
the route → endpoint map, see [`../README.md`](../README.md); for the rules in
their prescriptive form, see [`../AGENTS.md`](../AGENTS.md).

## One path, no exceptions

Every byte the studio reads from the API travels the same three hops:

1. A component calls a hook from [`../src/lib/hooks/`](../src/lib/hooks).
2. The hook calls `api.get|post|put|patch|del` from
   [`../src/lib/api.ts`](../src/lib/api.ts).
3. `apiFetch` calls `fetch` — the single call site in the package
   (`src/lib/api.ts:24`).

This is not aspirational. As the tree stands there is no `useQuery` or
`useMutation` outside `src/lib/hooks/`, and no non-test file outside `src/lib/`
imports `api` at all. What that buys you is concrete: a test can stub one global
`fetch` and drive a whole screen through the real hooks, which is exactly what
`src/app/repos/[repoId]/conventions/_components/ConventionsView/ConventionsView.test.tsx:112`
does.

One component holds a `useQueryClient` directly —
`src/app/repos/[repoId]/pulls/[number]/page.tsx:45` — because SSE run events
settle outside React Query and the page has to nudge two entries when they do
(`:52-58`). Note what it still does not do: it imports `runKeys` (`:21`)
rather than writing a key by hand.

## What `apiFetch` normalises

`apiFetch<T>` (`src/lib/api.ts:21-63`) exists for four reasons, and each is a
thing you would otherwise get wrong per call site:

- **Base URL.** `API_BASE` comes from `NEXT_PUBLIC_API_BASE`, defaulting to
  `http://localhost:3001` (`src/lib/api.ts:5-6`). It is baked in at build time —
  see the gotcha in [`../AGENTS.md`](../AGENTS.md).
- **Conditional JSON content-type.** The header is set only when a body is
  actually present (`src/lib/api.ts:30`).
- **`204` handling.** A no-content response resolves to `undefined` instead of
  throwing on an empty `res.json()` (`src/lib/api.ts:61`).
- **Error normalisation.** Anything non-2xx becomes an `ApiError`
  (`src/lib/api.ts:44-58`).

### Body-less POSTs

To fire a POST or PUT that carries nothing, pass no second argument:
``api.post<Repo>(`/repos/${repoId}/refresh`)`` (`src/lib/hooks/core.ts:93`).

The wrapper then sends no body — `body ? JSON.stringify(body) : undefined`
(`src/lib/api.ts:68`) — and because `init.body` is nullish, `apiFetch` omits the
`content-type` header (`src/lib/api.ts:30`). That omission is load-bearing.
Fastify rejects an empty body that claims to be `application/json`, and the
routes on the other end declare params only, no body schema:
`server/src/modules/repos/routes.ts:38` and
`server/src/modules/reviews/routes.ts:114`. `useFindingAction` shows the
conditional form of the same thing — `reply ? { reply } : undefined`
(`src/lib/hooks/reviews.ts:156`).

Two edges worth knowing. The wrapper tests the body for **truthiness**, so
`api.post(path, 0)`, `api.post(path, "")` and `api.post(path, false)` also send
nothing; pass `{ value: 0 }` if you mean to send a falsy payload. And `apiFetch`
tests `init?.body != null` instead, so calling `apiFetch` directly with
`body: ""` *does* set the header and *does* hit the Fastify rejection. Never add
`content-type` at a call site.

## `ApiError`, and who reads `status`

`ApiError` carries `status`, and optional `code` and `details` lifted from the
API's `{ error: { code, message, details } }` envelope
(`src/lib/api.ts:8-19`, `50-54`); that envelope is the shared contract
`ApiErrorBody` (`src/vendor/shared/contracts/platform.ts:281-287`). A transport
failure — API down, wrong port — becomes `status: 0` with code `network_error`
(`src/lib/api.ts:36-41`).

`status` has exactly one reader today: the global `QueryCache` / `MutationCache`
handlers in `src/lib/providers.tsx:35-43`. The split there is deliberate.

- **Mutations always toast.** A mutation is a user action, so silence would read
  as a dropped click (`src/lib/providers.tsx:41-43`).
- **Queries toast only on `status === 0` or `>= 500`**
  (`src/lib/providers.tsx:38`). An expected 4xx stays silent so the screen can
  render it inline — `useConventionSkillDraft` relies on this for its 422
  "nothing accepted yet" case (`src/lib/hooks/conventions.ts:91-107`).

Everywhere else, components branch on `error instanceof ApiError` and read
`.message` only, never `.status` — for example
`src/app/repos/[repoId]/pulls/page.tsx:127` and
`src/app/agents/[id]/page.tsx:45`. So the "inline versus full-screen" half of
the taxonomy is decided by *which component caught the error*, not by its status
code. Do not assume a status-driven dispatcher exists; there isn't one.

## Cache keys come from `keys.ts`

Every key is a factory in [`../src/lib/hooks/keys.ts`](../src/lib/hooks/keys.ts),
re-exported through the barrel (`src/lib/hooks/index.ts:4`). No inline
`queryKey: [...]` literal exists anywhere in `src/` today. Keep it that way, and
here is the mechanism rather than the slogan:

Nothing type-checks a key literal. `queryKey` accepts any array, so
`useQuery({ queryKey: ["reviwes", prId] })` compiles cleanly. At runtime the
entry is stored under the typo'd key, the matching mutation invalidates the
factory key, the two never meet, and no handler in `src/lib/providers.tsx:35-43`
fires because nothing failed. The defaults then keep the wrong pixels on screen:
`staleTime: 30_000` and `refetchOnWindowFocus: false`
(`src/lib/providers.tsx:28-29`) mean nothing re-reads that entry until a remount
after the stale window. The user sees a green mutation and unchanged data. Using
`reviewKeys.byPr(prId)` moves that failure to compile time, because a typo'd
*factory name* is a type error.

Keys accept `string | number | null | undefined` (`src/lib/hooks/keys.ts:24`) on
purpose: hooks stay mounted while an id is still resolving and gate the request
with `enabled` instead — `usePullDetail` (`src/lib/hooks/core.ts:122-128`) is the
canonical shape, and it needs `number` because the PR route is keyed by PR number
while the API is keyed by uuid.

**Check the tuples before relying on prefix invalidation.** `invalidateQueries`
matches by key prefix, so it is tempting to treat every `.all` as an umbrella
over its group's `.detail`. Some groups do nest — `conventionKeys`
(`["conventions"]` / `["conventions", repoId]`, `src/lib/hooks/keys.ts:83-85`)
and `providerModelKeys` (`:38-39`). Others do not: `agentKeys.all` is
`["agents"]` while `agentKeys.detail(id)` is `["agent", id]` (`:64-65`), plural
against singular, so invalidating `.all` never reaches a detail entry.
`skillKeys` (`:72-74`) and `pullKeys` (`:48-51`) have the same shape. That is
precisely why `useUpdateAgent` invalidates the list *and* seeds the detail entry
(`src/lib/hooks/agents.ts:66-69`) and `useDeleteAgent` invalidates the list *and*
removes the detail entry (`:77-79`). The header comment in `keys.ts:9-12`
generalises the nesting property to every group and cites a `reviewKeys.all` that
does not exist (`reviewKeys` has only `byPr`, `:92-94`) — trust the tuples.

## Invalidate, seed, or remove

Three post-mutation moves, and the choice is about what the user sees during the
round trip:

- **Invalidate** when a refetch is cheap and no visible control depends on the
  answer arriving this frame — `useAddRepo` (`src/lib/hooks/core.ts:86`).
- **Seed with `setQueryData`** when the response already *is* the new state and a
  refetch would flash the old one. A skill reorder returns the full re-ordered
  list for this reason (`src/lib/hooks/skills.ts:112-129`), and the conventions
  screen seeds one item inside its `{ scan, items }` entry so an accept does not
  blank the counter (`src/lib/hooks/conventions.ts:109-124`).
- **Remove with `removeQueries`** when the entity is gone, not stale
  (`src/lib/hooks/agents.ts:79`, `src/lib/hooks/skills.ts:93`).

Cross-domain fan-out is normal and must be explicit: editing a skill body
invalidates the skill list, its versions *and* every agent, because each agent's
rendered prompt changed (`src/lib/hooks/skills.ts:77-83`).

## Polling and refetch

Global defaults are `retry: 1`, `staleTime: 30_000`,
`refetchOnWindowFocus: false` (`src/lib/providers.tsx:26-30`). Hooks override
narrowly:

- **Data-driven predicates over boolean flags.** `usePrRuns` polls only while a
  run is `running` (`src/lib/hooks/reviews.ts:46-48`) and `useConventions` only
  while the server's scan status is `queued` or `running`
  (`src/lib/hooks/conventions.ts:39-41`). Nothing in the page has to remember
  that it started something.
- **Caller-owned polling** where the terminal condition is not in the status
  enum: `useRepoIntelStatus(repoId, poll)` (`src/lib/hooks/repo-intel.ts:32-39`).
- `usePulls` re-enables focus refetching and polls every 60 s to re-sync PR state
  from GitHub (`src/lib/hooks/core.ts:117-118`).
- `useRunTrace` sets `retry: false` (`src/lib/hooks/trace.ts:18`).

## Two things this layer does not cover

**Live run output is not in the cache.** `useRunEvents` opens one `EventSource`
per run id and accumulates events in React state
(`src/lib/hooks/reviews.ts:169-217`). Consequences: the log does not survive
navigation, React Query devtools show nothing for it, and an SSE `error` frame is
toasted from inside the hook (`:190`) because no query or mutation ever sees it.

**A hook can compile against an endpoint that does not exist.** `api.get<T>`
takes a plain string, so nothing checks the path. `useContextFiles` and
`useReindexContext` (`src/lib/hooks/core.ts:131-145`) target
`/repos/:id/context` and `/repos/:id/context/reindex`, and no server module
registers either; `repo-intel` serves `/repos/:id/index-state` and
`/repos/:id/resync` instead (`server/src/modules/repo-intel/routes.ts:33`,
`:44`). Before you wire a hook into a screen, confirm a route serves it.
