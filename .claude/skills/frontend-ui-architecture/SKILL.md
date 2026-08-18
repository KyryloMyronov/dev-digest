---
name: frontend-ui-architecture
description: "Frontend UI architecture and code organization for React + Next.js App Router (2024-26 consensus). Use when deciding WHERE code lives and HOW to structure it: folder structure, feature boundaries, component decomposition, business logic and state placement, constants/utils/types/API-layer organization, RSC boundary architecture, Server Actions and the Data Access Layer. Does NOT cover React rendering/hooks anti-patterns (react-best-practices) or Next.js file-convention mechanics and optimization (next-best-practices)."
version: 1.0.0
---

# Frontend UI Architecture

Architecture and code-organization rules for a React + TypeScript + Next.js
(App Router) frontend. Every rule below is the 2024–2026 cross-source consensus
of official docs (react.dev, nextjs.org, TypeScript handbook), Bulletproof
React, Feature-Sliced Design, and recognized practitioners (Dan Abramov,
Kent C. Dodds, TkDodo, Robin Wieruch, Josh Comeau, Nadia Makarevich,
Matt Pocock). Sources with links: [README.md](README.md). Code shapes:
[examples.md](examples.md).

**The one meta-rule**: colocate by default; promote to a shared layer only
when a *second* feature actually needs the code. This single rule governs
components, constants, utils, hooks, and types alike.

---

## 1. Project structure

- **Feature folders over type folders.** Type-based grouping (`components/`,
  `hooks/`, `utils/` at top level) is acceptable only for small apps. As the
  app grows, organize by feature: `features/<name>/` containing only the
  segments it needs (`api/`, `components/`, `hooks/`, `stores/`, `types/`,
  `utils/`).
- **Unidirectional imports: `shared → features → app`.** Features never import
  from other features and never from the app layer; shared code never imports
  upward. Compose features at the application (page/route) level. Enforce with
  ESLint `import/no-restricted-paths` (see §8).
- **Shallow nesting** — max 2–4 levels. Don't over-design the tree up front;
  let structure evolve (official React guidance: "don't spend more than five
  minutes on choosing a file structure").
- **In Next.js App Router**: route-scoped code lives in private folders inside
  the route segment (`app/blog/_components/`, `app/blog/_lib/`); truly shared
  code lives outside `app/` (or at its root). Route groups `(group)` organize
  sections without affecting URLs. Pick one strategy and stay consistent.
- **Duplication is acceptable until real reuse appears** (FSD 2.1 "pages
  first"). Don't create `shared`/`entities`-style layers speculatively.

## 2. Component decomposition

- **Single responsibility**: a component should be concerned with one thing;
  if it grows, decompose it (react.dev "Thinking in React").
- **Split on experienced problems, not line counts**: re-render performance,
  actual reuse, confusing state, unwieldy tests, merge conflicts. Long JSX is
  easier to maintain than a premature abstraction (Dodds). Never extract
  speculatively.
- **AHA — prefer duplication over the wrong abstraction** (Sandi Metz /
  Dodds). Abstract only when commonalities are unmistakable.
- **Implement or compose, not both** (Makarevich): a component either
  implements a piece of a feature or composes other components. Practical
  extraction triggers: doesn't fit on a laptop screen; manages state
  irrelevant to its purpose; heavy state re-renders unrelated children.
- **Composition escalation order** for passing data down: children/slot
  composition → colocate or lift state → context near consumers → external
  store. Prop drilling through one or two levels is fine — it keeps data flow
  explicit. Compound components only when consumers need structural
  flexibility.
- Prefer early returns per UI state + a `children`-accepting layout component
  over conditional-rendering soup. If the layout component needs many
  parameters, the abstraction is wrong (TkDodo).

## 3. Business logic placement

The container/presentational (smart/dumb) component split is **deprecated by
its own author** (Abramov, 2019). The separation survives, relocated:

| Layer | Holds | Lives in |
|---|---|---|
| Components | UI only | `features/<name>/components/`, route `_components/` |
| Custom hooks | Stateful/reactive logic | `features/<name>/hooks/` |
| Plain TS modules | Pure business rules (testable without React) | `features/<name>/lib|utils/` or a domain module |
| Query/API layer | Server I/O | `features/<name>/api/` (client) · DAL / `queries`+`actions` (server, §6) |

- Derived values are computed during render; user-action logic goes in event
  handlers; Effects only synchronize with external systems (react.dev "You
  Might Not Need an Effect").
- Wrap every `useQuery` in a custom hook, even for one call — keeps fetching
  out of the UI, centralizes keys/types/transforms (TkDodo).
- Custom hooks: `use` prefix mandatory (forbidden for non-hooks); named by
  concrete use case (`useChatRoom`, `useMediaQuery`); never generic lifecycle
  wrappers (`useMount`, `useEffectOnce`). "If you struggle to pick a clear
  name, it's not ready to be extracted."

## 4. State placement

- **Server state ≠ client state.** Fetched data is owned by the server —
  never mirror it into `useState`/Zustand/Redux. TanStack Query (or RSC, §6)
  owns server state; client stores hold only genuinely client-owned state
  (theme, wizard steps, session UI).
- **Placement ladder**: local state first (colocation is a continuous
  discipline) → lift to the closest common parent → context only after
  children-composition fails, with providers close to consumers → a small
  external store (Zustand/Redux) for the truly-global remainder.
- URL-dependent state (filters, pagination, search) belongs in URL search
  params.

## 5. Constants, utils, types, client API layer

- **Constants**: colocate per feature; promote on second use. App-wide config
  goes in `src/config/` — no global `constants/` dumping ground.
  SCREAMING_SNAKE_CASE only for exported, truly immutable values; locals stay
  camelCase even if `const`.
- **`as const` objects over `enum`** (TS handbook, Pocock): derive unions via
  `typeof OBJ[keyof typeof OBJ]`. Never `const enum`.
- **`utils/` = pure, generic, shared functions**, organized by purpose
  (`utils/format/date.ts`), never one junk-drawer file. **`lib/` =
  preconfigured third-party facades** (api client, query client). Skip
  `helpers/` — it adds no meaning beyond utils. Anything touching I/O or app
  state is not a util.
- **Types**: colocate — props types next to the component (same file is
  fine); per-feature `types.ts` when several files share them; global
  `src/types/` only for cross-cutting domain entities and API DTOs. No `.d.ts`
  for app types.
- **Client API layer**: one configured client wrapper in `src/lib/`;
  everything else per feature — `features/<name>/api/` with one file per
  endpoint exporting the fetch fn + its hook. Query keys colocated per
  feature, generic → specific; prefer **`queryOptions` factories** (Query v5).
  No global `queryKeys.ts`.
- **No barrel files (`index.ts` re-exports) in app code** — direct imports
  only. Barrels load every module they touch, invite circular imports, and
  multiply module counts (Vercel measured 11,738 modules for one icon barrel;
  Bulletproof React reversed its old pro-barrel stance). Sole legitimate use:
  a published library's public entry point.

## 6. Next.js App Router architecture

Boundary mechanics (`'use client'` validity rules, async APIs, file
conventions) are covered by the `next-best-practices` skill; this section is
the *architecture*.

- **Pages and layouts stay Server Components; push `'use client'` to the
  leaves.** The directive marks a module-graph boundary — everything a marked
  file imports goes to the client bundle. Small interactive leaf components
  receive minimal, serializable, already-fetched data as props.
- **Interleave via children**: pass Server Components as `children`/props into
  Client Components (server `<Cart/>` inside client `<Modal>`); they stay out
  of the client graph. Render context providers as deep as possible.
- **Fetch in Server Components directly at the source** (ORM/DB/fetch), never
  through your own Route Handlers. Route Handlers are the BFF surface
  (webhooks, public endpoints, non-HTML responses). Request memoization +
  `React.cache` make "fetch where you need it" safe — no prop drilling of
  data.
- **Data Access Layer (DAL)** — the recommended architecture for new projects
  (Markbåge/Vercel): a `server-only` module consolidating all data access;
  every function authorizes against the current session (`verifySession()`
  wrapped in `React.cache`) before returning; returns minimal **DTOs**, never
  raw DB/API objects. Only the DAL reads `process.env`. Auth checks live near
  the data, **not in layouts** (layouts don't re-render on client navigation
  and don't gate parallel slots).
- **Client-side TanStack Query is the exception, not the default**: polling/
  realtime, infinite scroll, client-only Web APIs. If mixing: prefetch in the
  RSC → `dehydrate` → `<HydrationBoundary>` → `useQuery` in the client; never
  render the same data from both worlds.
- **Server Actions are public POST endpoints.** Arguments are fully
  client-controlled; TS types are not runtime-enforced. Every action: validate
  with Zod at the top → authorize via the DAL → mutate. Actions are for
  mutations only (they dispatch sequentially) — reads use plain server
  functions. Colocate per feature: `features/<name>/actions/` (mutations) +
  `features/<name>/queries/` (reads), or the feature's `api/` segment.
- **Middleware (`proxy.ts` in Next 16) is never the sole auth layer**
  (CVE-2025-29927 postmortem): optimistic cookie checks and redirects only,
  no DB calls; real authorization lives in the DAL.
- **Enforce the server/client split at build time**: `import 'server-only'` in
  every DAL/secret-touching module, `client-only` for browser-bound code.
- Parallel routes (`@slot`) and templates are opt-in tools, not defaults:
  slots for dashboards/conditional role-based UI (authorize inside each slot —
  both render server-side regardless of the layout conditional) and modal
  interception; `template.js` only when remount-per-navigation semantics are
  required.

## 7. Where a new piece of code goes — decision table

| You are adding… | It goes to… |
|---|---|
| A component used by one route | `app/<route>/_components/` (or the feature's `components/`) |
| A component used by 2+ features | shared `components/` |
| A constant used by one feature | that feature (top of the file using it, or feature `constants.ts`) |
| App-wide config / env access | `src/config/` (client) · DAL (server secrets) |
| A pure generic function | feature `utils/` → promote to `src/utils/<purpose>/` on second use |
| A configured 3rd-party instance | `src/lib/` |
| Stateful reusable logic | a custom hook in the feature; shared `hooks/` on second use |
| Pure business rules | plain TS module in the feature (server: behind the DAL) |
| A new server data read | DAL / feature `queries/` (server fn), fetched in an RSC |
| A new mutation | Server Action in feature `actions/` with Zod + auth, or feature `api/` mutation hook |
| Types for one component | same file as the component |
| Types shared across the app | `src/types/` (domain entities, DTOs only) |

## 8. Enforcement (lint the architecture)

- `import/no-restricted-paths` — zones blocking cross-feature imports and
  upward imports (`shared ← features ← app`).
- `import/no-cycle: error` — bans circular imports (also the barrel-file
  failure mode).
- `no-restricted-syntax` on `TSEnumDeclaration` (or TS `erasableSyntaxOnly`)
  — bans enums.
- `eslint-plugin-check-file` — consistent file/folder naming.
- `eslint-plugin-boundaries` — heavier declarative alternative for layer
  rules.

Config shapes in [examples.md](examples.md).
