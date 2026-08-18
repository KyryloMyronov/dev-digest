# React / Frontend Code Organization — Research Notes

Raw material for the future `react-frontend-structure` skill. Compiled 2026-08-07
from three parallel deep-research passes; every source marked **verified** was
fetched and confirmed to say what is claimed. This file is the input for the
skill's `SKILL.md` and the source list for its `README.md`.

Scope: where components live, how to split them, where constants / utils /
helpers / types go, and where business logic belongs in a React + TypeScript
frontend (2024–2026 consensus).

---

## 1. Where components live (project structure)

- **Colocation is the universal principle** — "place code as close to where it's
  relevant as possible" (Kent C. Dodds; also the legacy React FAQ). Payoff:
  maintainability and *deleteability* — delete a component and its helpers,
  tests, styles go with it.
- **Feature-based beats type-based as apps grow.** Type-based folders
  (`components/`, `hooks/`, `utils/`) are fine for small apps; feature folders
  (`features/user/`) become necessary at scale. Robin Wieruch documents a
  5-step evolution: single file → per-component folder → technical folders →
  feature folders + shared technical folders for reusable code.
- **Shallow nesting**: legacy React FAQ says max 3–4 levels; Wieruch says max 2.
  Also from the FAQ: "don't spend more than five minutes on choosing a file
  structure" — let it evolve.
- **Bulletproof React** (the de-facto community standard, ~35k stars):
  `src/app` (routes, providers) · `assets` · `components` (shared) · `config` ·
  `features/<name>/{api,components,hooks,stores,types,utils}` (only the ones
  needed) · `hooks` · `lib` · `stores` · `testing` · `types` · `utils`.
  **Unidirectional imports: `shared → features → app`.** No cross-feature
  imports — compose features at the app level. Enforced with ESLint
  `import/no-restricted-paths`.
- **Feature-Sliced Design (FSD)** — the heavier, standardized alternative:
  layers `app → pages → widgets → features → entities → shared`, slices
  (business domains) inside layers, segments (`ui`, `api`, `model`, `lib`,
  `config`) inside slices. A slice may only import from layers strictly below;
  same-layer slices never import each other. **FSD 2.1 (2024) "Pages first"**:
  start with just `shared/`, `pages/`, `app/`; keep non-reused code in the
  page's slice; add other layers only when actually (not hypothetically)
  reused. Duplication is acceptable until real reuse appears.
- **Next.js App Router** is officially unopinionated but documents three
  strategies; the one matching this repo: globally shared code outside/at the
  root plus **route-scoped code colocated in route segments via private
  folders** — `app/blog/_components/Post.tsx`, `app/blog/_lib/data.ts`.
  Colocation inside `app/` is safe by default (nothing is routable without
  `page.js`/`route.js`); the `_folder` prefix additionally opts out of routing
  and avoids collisions with future file conventions. Route groups `(folder)`
  organize routes without affecting URLs. The `_components/` pattern already
  used in this repo's `client/` is exactly this documented convention.
- **react.dev has no file-structure page** — modern official docs deliberately
  delegate structure to frameworks and community conventions; "Thinking in
  React" only covers conceptual decomposition (single responsibility, hierarchy
  from the mockup, UI mirroring the data model).
- Notable variant (Josh Comeau): function-first top level (`components/`,
  `hooks/`, `helpers/`) but aggressive colocation *within* each component's own
  directory (`FileViewer/FileViewer.tsx` + `FileViewer.helpers.ts` +
  sub-components).

## 2. How components are split (decomposition)

- **Single responsibility** (react.dev "Thinking in React"): "a component should
  ideally only be concerned with one thing. If it ends up growing, it should be
  decomposed into smaller subcomponents." The docs also model *deferred*
  extraction — keep it inline until it grows complex.
- **Split on experienced problems, not line counts** (Dodds, "When to break up
  a component"): break up when you hit re-render perf issues, reuse needs,
  confusing state, unwieldy tests, or merge conflicts — "NOT BEFORE." Long JSX
  is easier to maintain than a premature abstraction.
- **AHA programming** (Dodds / Sandi Metz): "prefer duplication over the wrong
  abstraction"; abstract only when commonalities scream at you; optimize for
  change.
- **Practical extraction triggers** (Nadia Makarevich): component doesn't fit
  on a laptop screen; heavy state causes needless child re-renders; it manages
  state irrelevant to its purpose. Rule: a component should either *implement*
  a feature or *compose* other components — not both ("don't stop halfway").
  Never extract speculatively.
- **Composition over conditional soup** (TkDodo): early returns per
  pending/empty/success state + a `children`-accepting layout component; if the
  layout component needs many params, it's the wrong abstraction.
- **Composition escalation order for prop drilling**: children/slots →
  colocate or lift state → context near consumers → external store. Prop
  drilling itself is often fine — it keeps data flow explicit (Dodds).
  Compound components (`<FlyOut.Toggle/>` via context) only when consumers
  need structural flexibility (patterns.dev).

## 3. Where business logic lives

- **Container/presentational (smart/dumb) is deprecated by its own author.**
  Dan Abramov's 2019 note on the founding article: "I don't suggest splitting
  your components like this anymore… Hooks let me do the same thing without an
  arbitrary division." patterns.dev concurs: "Modern React strongly favors
  Hooks over container components."
- **The separation survives, relocated**: UI in components → stateful/reactive
  logic in **custom hooks** → pure business rules in **plain TypeScript
  modules** (testable without React) → server communication behind a **query
  layer / api client**. For heavy domain logic, Juntao Qiu (martinfowler.com)
  formalizes this as view → hooks → domain models → data access.
- **Official placement rules** (react.dev "You Might Not Need an Effect"):
  derived values computed during render; user-action logic in event handlers;
  expensive computation in `useMemo`; Effects only for synchronizing with
  external systems. "Why does this code run? Displayed → Effect. User did
  something → event handler."
- **Wrap every `useQuery` in a custom hook** (TkDodo) — even for one call: it
  keeps fetching out of the UI and centralizes keys, types, transformations.
- **Custom hooks** (react.dev): `use` prefix mandatory (and forbidden for
  non-hooks); extract when Effect logic duplicates or to communicate intent;
  name by concrete use case (`useChatRoom`, `useMediaQuery`) — never generic
  lifecycle wrappers (`useMount`, `useEffectOnce`); "if you struggle to pick a
  clear name, it's not ready to be extracted." Hooks share stateful logic, not
  state.

## 4. State placement

- **Server state ≠ client state** (TkDodo; Dodds independently): fetched data
  is "borrowed", owned by the server — never mirror it into
  useState/Redux/Zustand. TanStack Query is the async state manager
  (stale-while-revalidate, `staleTime` for freshness); client stores hold only
  genuinely client-owned state (theme, wizard state, session UI).
- **Placement ladder**: local state first (colocation is a continuous
  refactoring discipline) → lift to closest common parent → context only after
  children-composition fails, with providers close to consumers, not at app
  root → external store (Zustand/Redux) for the small truly-global remainder.
  Zustand: subscribe via selectors to minimal slices; keep stores small.

## 5. Constants, utils, helpers, types, API layer

- **Constants**: colocate per feature by default; promote to shared when a
  second feature needs them (Wieruch's promotion rule). Bulletproof React has
  no `constants/` folder — app-wide config goes in `src/config/`. Comeau keeps
  one app-wide `constants.ts` for style constants/public keys.
  SCREAMING_SNAKE_CASE only for exported, truly immutable values (Airbnb 23.10;
  Google TS guide) — locals stay camelCase even if `const`.
- **Enums → `as const` objects.** Official TS handbook: "you may not need an
  enum when an object with `as const` could suffice." Matt Pocock: enums are
  nominally typed, numeric enums generate reverse mappings, dozens of unfixable
  bugs; use `as const` + derived union (`type X = typeof OBJ[keyof typeof OBJ]`).
  `const enum` is banned by Google's guide; TS 5.8 `erasableSyntaxOnly` outlaws
  enums entirely.
- **`utils/` vs `lib/` vs `helpers/`**: `utils/` = pure, generic, shared
  functions, organized by purpose (`utils/format/date-time.ts`), never one
  junk-drawer file; `lib/` = preconfigured third-party facades (axios client,
  query client, dayjs setup); skip `helpers/` — it adds no meaning beyond
  utils (Comeau's helpers-vs-utils distinction is project-specific vs generic,
  but Bulletproof and Wieruch both converge on utils+lib only). A util starts
  feature-local and is promoted to shared on second use.
- **Types**: colocate by default — props interfaces next to the component
  (often same file); per-feature `types.ts` when several files share them;
  global `src/types/` only for cross-cutting domain entities and API DTOs.
  Avoid `.d.ts` for app types (global leakage, no import discipline).
- **API layer**: one configured client wrapper globally (`src/lib/api-client`);
  everything else per feature — `features/<name>/api/` with one file per
  endpoint exporting the fetch fn + its hook. Query keys colocated per feature,
  structured generic → specific; since Query v5 prefer **`queryOptions`
  factories** (`todoQueries.detail(id)`) feeding useQuery / prefetch /
  invalidate alike. No global `queryKeys.ts`.
- **Barrel files (index.ts): don't, in app code.** TkDodo: barrels load every
  module synchronously, invite circular imports; removing internal barrels cut
  one Next.js app from ~11,000 to ~3,500 modules/page. Vercel measured
  `@material-ui/icons` at 11,738 modules and 200–800ms import cost; built
  `optimizePackageImports` as mitigation and advises apps to avoid own barrels.
  **Bulletproof React reversed its earlier pro-barrel stance** — now recommends
  direct imports. Sole legitimate use: a library's public entry point.
- **Lint-enforce the architecture**: `import/no-restricted-paths` zones (block
  cross-feature imports; block upward imports shared←features←app),
  `import/no-cycle: error`, `eslint-plugin-check-file` for naming,
  `eslint-plugin-boundaries` as the heavier declarative alternative. Ban enums
  via `no-restricted-syntax` (`TSEnumDeclaration`) or `erasableSyntaxOnly`.

---

## 6. Next.js App Router architecture (2024–2026)

Researched separately, architecture only (no perf/caching). Note: in Next 16
docs `middleware.ts` is renamed `proxy.ts` (same concept).

### Server/Client Component boundaries
- Layouts and pages are Server Components by default; Client Components are
  layered in only for interactivity (state, handlers, effects, browser APIs).
- **Push `'use client'` to the leaves** — mark specific interactive components,
  not large UI regions (official docs).
- `'use client'` is a **module-graph boundary**, not a per-component
  annotation: everything a marked file imports enters the client bundle. Mark
  entry points into client code (react.dev).
- **Interleaving**: pass Server Components as `children`/props into Client
  Components — they render on the server and are not pulled into the client
  graph (the "slot" pattern: server `<Cart/>` inside client `<Modal>`).
- Context providers are Client Components wrapping `{children}`; render them
  **as deep as possible**, not at app root.
- **Environment poisoning**: mark server-only modules with `import
  'server-only'` (build error if a Client Component imports them);
  `client-only` for the reverse.

### Data fetching architecture
- Default: **fetch in Server Components directly at the source** (ORM/DB/fetch),
  not via your own route handlers — calling Route Handlers from RSCs is an
  explicit anti-pattern (extra HTTP hop, breaks prerender). Route Handlers are
  the BFF surface: webhooks, public endpoints, non-HTML content, proxying.
- Request-level memoization + `React.cache` enable "fetch where you need it"
  instead of prop drilling.
- Client-side fetching (TanStack Query/SWR) is the exception: polling/realtime,
  infinite scroll, client-only Web APIs, offline.
- TanStack Query official RSC stance (TkDodo): RSC = "just another framework
  loader" — prefetch in RSC → `dehydrate` → `<HydrationBoundary>` →
  `useQuery` in Client Components. Never render the same data in both server
  and client components (they desync).
- **Data Access Layer (DAL) — Vercel's recommended architecture for new
  projects** (Markbåge): a `server-only` module consolidating all data access;
  every function takes the current user and authorizes before returning;
  returns **DTOs** (minimal, safe-to-serialize objects); only the DAL reads
  `process.env`. Auth checks live close to the data source, **not in layouts**
  (layouts don't re-render on client navigation and don't gate parallel
  slots). Taint APIs (`experimental_taintObjectReference`) are a backstop,
  not the mechanism.

### Server Actions ('use server')
- Separate actions file is mandatory when Client Components invoke them;
  community convention: colocate per feature (`features/<name>/actions/`,
  Wieruch; `features/<name>/api/`, Bulletproof React).
- **Actions ARE public endpoints**: arguments are fully client-controlled,
  invokable via direct POST with any args; TS types are not runtime-enforced.
  Validate at the boundary (Zod `safeParse`), then authorize via the DAL's
  `verifySession()`, then mutate.
- Actions are for **mutations, not reads** (POST, sequential dispatch).
  Community split: `queries/` (plain server fns for RSCs) vs `actions/`
  (mutations).
- `.bind()` arguments are NOT encrypted (unlike closures) — treat as hostile.

### Route organization
- Layouts persist state across navigations; `template.js` remounts per
  navigation — use templates only when remount semantics are needed.
- Route groups `(group)`: different layouts at the same URL level, scoping
  `loading.js`, multiple root layouts.
- Parallel routes `@slot`: dashboards with independent loading/error states,
  role-based conditional slots (**caveat: both slots render server-side —
  authorize in each slot's page/DAL, not the layout conditional**), and
  URL-shareable modals with intercepting routes `(.)`. Not a default.
- **Middleware/proxy is NOT an auth layer alone** (Vercel postmortem for
  CVE-2025-29927): optimistic cookie checks and redirects only, never DB
  calls; real checks live in the DAL.

### Layering / feature architecture in Next.js
- Official docs: three strategies, pick one and be consistent; strategy (c) =
  shared code at `app/` root or outside, feature/route-scoped code colocated
  in segments (`_components`, `_lib`).
- Bulletproof React has a dedicated `apps/nextjs-app` App Router sample with
  the same `features/` + unidirectional-import architecture.
- FSD official Next.js guide: `app/` router folder stays a thin routing shim;
  route files re-export page components from the FSD pages layer; server-only
  slice APIs exposed via separate `index.server.ts`.
- Wieruch's feature architecture: `features/<name>/{components,queries,actions,hooks}`;
  features stay decoupled via **composition at the page level**; `Promise.all`
  at composition boundaries against waterfalls.
- **Where business logic lives** (convergent answer): on the server, behind
  the DAL / per-feature query+action modules marked `server-only`; UI
  components (server or client) are thin consumers of DTOs.

### Next.js architecture sources
| Source | Author/Org | Covers | Verified |
|---|---|---|---|
| https://nextjs.org/docs/app/getting-started/server-and-client-components | Next.js docs | Boundary placement, leaves, interleaving, providers, env poisoning | ✅ |
| https://nextjs.org/blog/security-nextjs-server-components-actions | Sebastian Markbåge (Vercel) | DAL, DTOs, taint, Server Action security — the canonical RSC security text | ✅ |
| https://nextjs.org/docs/app/guides/authentication | Next.js docs | DAL implementation, `verifySession`, layouts-are-not-gates, Zod in actions | ✅ |
| https://vercel.com/blog/postmortem-on-next-js-middleware-bypass | Vercel | CVE-2025-29927; middleware not sole protection | ✅ |
| https://nextjs.org/docs/app/getting-started/fetching-data | Next.js docs | Server vs client fetching, `React.cache` | ✅ |
| https://nextjs.org/docs/app/guides/backend-for-frontend | Next.js docs | Route Handlers' role; no RSC→route-handler fetches; actions not for reads | ✅ |
| https://nextjs.org/docs/app/getting-started/mutating-data | Next.js docs | Server Function placement, invocation, auth in actions | ✅ |
| https://react.dev/reference/rsc/use-client | React team | `'use client'` as module-graph boundary | ✅ |
| https://react.dev/reference/rsc/use-server | React team | Untrusted args, per-action authorization | ✅ |
| https://nextjs.org/docs/app/api-reference/file-conventions/template | Next.js docs | Layout vs template semantics | ✅ |
| https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes | Next.js docs | Slots, conditional routes + auth caveat, modals | ✅ |
| https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr | TanStack (TkDodo) | prefetch + HydrationBoundary; RSC = loader | ✅ |
| https://tkdodo.eu/blog/you-might-not-need-react-query | TkDodo | When RSC replaces React Query | ✅ |
| https://feature-sliced.design/docs/guides/tech/with-nextjs | FSD org | FSD + App Router reconciliation | ✅ |
| https://www.robinwieruch.de/react-feature-architecture/ | Robin Wieruch | Vertical features with queries/actions; page-level composition | ✅ |
| https://www.robinwieruch.de/next-server-actions-fetch-data/ | Robin Wieruch | queries vs actions split; caveats of actions-for-reads | ✅ |

---

## Sources (for the skill's README)

### Official docs

| Source | Author/Org | Covers | Verified |
|---|---|---|---|
| https://react.dev/learn/thinking-in-react | React team | Component hierarchy, single responsibility, lifting state | ✅ |
| https://react.dev/learn/reusing-logic-with-custom-hooks | React team | Custom hook naming, extraction criteria, anti-patterns | ✅ |
| https://react.dev/learn/you-might-not-need-an-effect | React team | Where logic belongs: render, event handlers, Effects | ✅ |
| https://react.dev/learn/passing-data-deeply-with-context | React team | Composition before context; context overuse warning | ✅ (via search) |
| https://legacy.reactjs.org/docs/faq-structure.html | React team | Feature vs type grouping, colocation, nesting ≤3–4, "don't overthink" | ✅ |
| https://nextjs.org/docs/app/getting-started/project-structure | Vercel | Safe colocation in `app/`, `_folder` private folders, route groups, 3 strategies | ✅ |
| https://www.typescriptlang.org/docs/handbook/enums.html#objects-vs-enums | TypeScript team | "You may not need an enum"; `const enum` pitfalls | ✅ |
| https://tanstack.com/query/latest/docs/framework/react/reference/queryOptions | TanStack | Official `queryOptions` reference | ✅ (via search) |

### Architecture guides & methodologies

| Source | Author/Org | Covers | Verified |
|---|---|---|---|
| https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md | Alan Alickovic | Folder layout, features/, lib vs utils, unidirectional imports, anti-barrel | ✅ |
| https://github.com/alan2207/bulletproof-react/blob/master/apps/react-vite/.eslintrc.cjs | Alan Alickovic | Working `import/no-restricted-paths` + `no-cycle` + check-file config | ✅ |
| https://feature-sliced.design/docs/get-started/overview | FSD core team | Layers/slices/segments overview, when to adopt | ✅ |
| https://feature-sliced.design/docs/reference/layers | FSD core team | All 7 layers, downward-only import rule | ✅ |
| https://github.com/feature-sliced/documentation/releases/tag/v2.1 | FSD core team | v2.1 "Pages first", minimal layer set | ✅ (via search) |
| https://www.martinfowler.com/articles/modularizing-react-apps.html | Juntao Qiu (martinfowler.com) | Layered React: views / hooks / domain models / data access | ✅ |
| https://www.patterns.dev/react/presentational-container-pattern/ | patterns.dev (Hallie/Osmani) | "Modern React strongly favors Hooks over container components" | ✅ |
| https://www.patterns.dev/react/compound-pattern/ | patterns.dev | Compound components via context, tradeoffs | ✅ |

### Practitioner essays

| Source | Author | Covers | Verified |
|---|---|---|---|
| https://kentcdodds.com/blog/colocation | Kent C. Dodds | Colocation principle; deleteability | ✅ |
| https://kentcdodds.com/blog/when-to-break-up-a-component-into-multiple-components | Kent C. Dodds | Split on real problems, never preemptively | ✅ |
| https://kentcdodds.com/blog/aha-programming | Kent C. Dodds | Avoid Hasty Abstractions | ✅ |
| https://kentcdodds.com/blog/state-colocation-will-make-your-react-app-faster | Kent C. Dodds | State colocation, lift-vs-push | ✅ |
| https://kentcdodds.com/blog/application-state-management-with-react | Kent C. Dodds | Server cache vs UI state; React built-ins first | ✅ |
| https://kentcdodds.com/blog/prop-drilling | Kent C. Dodds | Prop drilling is often fine; mitigations | ✅ (via search) |
| https://medium.com/@dan_abramov/smart-and-dumb-components-7ca2f9a7c7d0 | Dan Abramov | Container/presentational + 2019 retraction | ✅ |
| https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction | Sandi Metz | "Duplication is far cheaper than the wrong abstraction" | ✅ (cited via Dodds) |
| https://tkdodo.eu/blog/practical-react-query | Dominik Dorfmeister (TkDodo) | Server-state ownership; custom hooks around useQuery | ✅ |
| https://tkdodo.eu/blog/react-query-as-a-state-manager | TkDodo | Query as async state manager; staleTime | ✅ |
| https://tkdodo.eu/blog/effective-react-query-keys | TkDodo | Per-feature colocated key factories, generic→specific | ✅ |
| https://tkdodo.eu/blog/the-query-options-api | TkDodo | `queryOptions` factories (v5) | ✅ |
| https://tkdodo.eu/blog/component-composition-is-great-btw | TkDodo | Early returns + layout components over conditional soup | ✅ |
| https://tkdodo.eu/blog/please-stop-using-barrel-files | TkDodo | Barrel harms: cycles, 11k→3.5k modules | ✅ |
| https://tkdodo.eu/blog/working-with-zustand | TkDodo | Zustand: selectors, small stores | ✅ (via search) |
| https://www.joshwcomeau.com/react/file-structure/ | Josh W. Comeau | Per-component directories; helpers vs utils; app-wide constants.ts | ✅ |
| https://www.robinwieruch.de/react-folder-structure/ | Robin Wieruch | 5-step structure evolution; promotion rule; ≤2 nesting | ✅ |
| https://www.developerway.com/posts/components-composition-how-to-get-it-right | Nadia Makarevich | Extraction triggers; implement-or-compose rule | ✅ |
| https://www.totaltypescript.com/why-i-dont-like-typescript-enums | Matt Pocock | Enum pitfalls; `as const` + derived unions | ✅ |

### Style guides, performance & tooling

| Source | Author/Org | Covers | Verified |
|---|---|---|---|
| https://google.github.io/styleguide/tsguide.html | Google | CONSTANT_CASE scope, `const enum` ban, no default exports | ✅ |
| https://github.com/airbnb/javascript#naming--uppercase | Airbnb | Uppercase only exported truly-immutable constants | ✅ |
| https://vercel.com/blog/how-we-optimized-package-imports-in-next-js | Shu Ding (Vercel) | Barrel import cost data; `optimizePackageImports` | ✅ |
| https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/ | Marvin Hagemeister | Tooling-performance cost of barrel files | ✅ (via search) |
| https://github.com/javierbrea/eslint-plugin-boundaries | Javier Brea | Declarative architectural linting | ✅ (via search) |
| https://profy.dev/article/react-folder-structure | Johannes Kettmann | Survey of real-world React structures; types placement | ✅ (via search) |

---

## Cross-source consensus (candidate skill rules)

1. **Colocate by default; promote to shared on second use** — the single rule
   underlying constants, utils, hooks, and types placement.
2. **Feature folders + unidirectional imports** (`shared → features → app`),
   no cross-feature imports, lint-enforced.
3. **Split components on real pain** (perf, reuse, confusing state, tests),
   never on line counts or speculation; prefer duplication over the wrong
   abstraction.
4. **Business logic ladder**: components (UI) → custom hooks (stateful logic)
   → plain TS modules (pure rules) → query layer (server I/O). The old
   smart/dumb component split is deprecated by its own author.
5. **State ladder**: local → lift → context near consumers → small external
   store; server state lives exclusively in TanStack Query, never mirrored.
6. **`utils/` = pure generic fns by purpose; `lib/` = configured third-party
   facades; no `helpers/`, no junk drawer.**
7. **`as const` objects over enums**; SCREAMING_SNAKE_CASE only for exported
   immutables.
8. **Per-feature `api/` with `queryOptions` factories**; one global api-client
   wrapper.
9. **No barrel files in app code** — direct imports; barrels only as a
   library's public entry.
10. **In Next.js App Router**: route-scoped code in `_components`/`_lib`
    private folders inside the route segment; truly shared code outside.
