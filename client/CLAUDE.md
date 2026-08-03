# `@devdigest/web` — client

Next.js 15 studio. UI route map: [`README.md`](README.md).
Root rules: [`../CLAUDE.md`](../CLAUDE.md).

## Stack additions

Beyond the root stack: `next-intl` 3 · `lucide-react` · `recharts` 2 ·
`mermaid` 11 · `react-markdown` 9 + `remark-gfm` · Tailwind 4 via
`@tailwindcss/postcss` · Testing Library + jsdom.

## Commands

```sh
pnpm dev            # :3000 — needs the API on :3001 to show anything
pnpm build          # next build
pnpm typecheck
pnpm test           # vitest + jsdom
```

## Where things live

```
src/app/                     App Router pages; feature UI colocated in _components/
src/components/              shared across routes (app-shell, diff-viewer, page-shell)
src/lib/api.ts               the ONLY place that talks HTTP
src/lib/hooks/               typed React Query hooks, one file per domain
src/vendor/shared/           mirror of @devdigest/shared (contracts)
src/vendor/ui/               the in-repo design system (kit, primitives, charts, shell)
messages/en/                 next-intl message catalogues
```

## Non-default conventions

- **Never `fetch` in a component.** All server access goes through
  `lib/api.ts` → a hook in `lib/hooks/`. That layer normalises the error
  envelope into `ApiError`, which the error UX branches on by `status`.
- **Types come from `@devdigest/shared`, never hand-written.** If a response
  shape looks wrong, the fix is in the contract, not in a local interface.
- **`src/vendor/shared/` is a copy, not the source** — canonical is
  `server/src/vendor/shared/`. Never edit only this side.
- **Feature components colocate** under the route that owns them, in
  `_components/<ComponentName>/`. Promote to `src/components/` only once a second
  route uses it.
- **UI comes from `src/vendor/ui`.** Don't add a component library, and don't
  hand-roll a primitive that the kit already has — see
  [`src/vendor/ui/README.md`](src/vendor/ui/README.md).
- **User-facing strings go through next-intl** (`messages/en/`), not inline
  literals.
- Server Components by default; `"use client"` only where interactivity or a
  hook requires it. All React Query hooks are client-side.

## Gotchas

- **`NEXT_PUBLIC_API_BASE`** (default `http://localhost:3001`) is baked in at
  build time. Changing it needs a rebuild, not just a restart.
- **A blank/erroring studio usually means the API is down, not a UI bug** —
  `api.ts` surfaces that as `ApiError` with `status: 0` and code
  `network_error`. Check `:3001/health` first.
- **Body-less POSTs must not send a JSON content-type** — Fastify rejects them
  with "Body cannot be empty". `apiFetch` already handles this; don't add the
  header manually (`lib/api.ts:26`).
- Run cancellation and live run logs arrive over **SSE**, not polling — a stuck
  run panel is usually a dropped `EventSource`, not stale query cache.
- pnpm 11 needs `allowBuilds:` entries in `pnpm-workspace.yaml` for `esbuild`
  and `sharp`; a placeholder value counts as unapproved and fails install.

## Do-not-touch

- `src/vendor/**` — mirrored/vendored; change the source of truth instead.
- `.next/`, `next-env.d.ts` — generated.

## Docs

UI route map → [`README.md`](README.md) ·
Design system → [`src/vendor/ui/README.md`](src/vendor/ui/README.md) ·
Testing strategy → [`../TESTING.md`](../TESTING.md) ·
Learned gotchas → [`insights.md`](insights.md) · Unbuilt work → [`specs/`](specs/README.md)

Relevant skills: `react-best-practices`, `next-best-practices`,
`react-testing-library`, `zod`, `dataviz` (for any chart work).