# frontend-ui-architecture

**Version 1.0.0** · Authored in this repo (not vendored, not hash-locked).

A skill for frontend UI architecture and code organization: where components,
constants, utils, types, and business logic live in a React + TypeScript +
Next.js (App Router) codebase, and how to keep the structure enforceable.

## Scope & relation to other skills

| Skill | Owns |
|---|---|
| **frontend-ui-architecture** (this) | Where code lives, how it's layered, feature boundaries, import direction, RSC/DAL/Server-Action *architecture* |
| `react-best-practices` | React rendering/hooks anti-patterns, state hygiene, memoization, a11y |
| `next-best-practices` | Next.js file-convention *mechanics*, async APIs, optimization, hydration |

## Files

- [SKILL.md](SKILL.md) — the rules (8 sections + a "where does this code go" decision table)
- [examples.md](examples.md) — target folder tree, code shapes, ESLint config
- [RESEARCH.md](RESEARCH.md) — full research notes the skill was distilled from

## Method

Compiled 2026-08-07 from four parallel deep-research passes (project
structure · component decomposition & logic placement · constants/utils/types/
API layer · Next.js App Router architecture). Every source below was recorded
with its exact claim; sources marked ✅ were fetched and verified to say what
is claimed. The skill encodes only positions where multiple independent
authoritative sources converge.

## Sources

### Official documentation

| Source | Author/Org | Used for |
|---|---|---|
| [Thinking in React](https://react.dev/learn/thinking-in-react) | React team | Single responsibility, component hierarchy, lifting state |
| [Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks) | React team | Hook naming, extraction criteria, anti-pattern lifecycle hooks |
| [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) | React team | Where logic belongs: render / event handlers / Effects |
| [Passing Data Deeply with Context](https://react.dev/learn/passing-data-deeply-with-context) | React team | Composition before context |
| [`'use client'` reference](https://react.dev/reference/rsc/use-client) | React team | Module-graph boundary semantics |
| [`'use server'` reference](https://react.dev/reference/rsc/use-server) | React team | Untrusted action arguments, per-action authorization |
| [Legacy FAQ: File Structure](https://legacy.reactjs.org/docs/faq-structure.html) | React team | Feature vs type grouping, colocation, nesting limits |
| [Next.js: Project Structure](https://nextjs.org/docs/app/getting-started/project-structure) | Vercel | Safe colocation, `_private` folders, route groups, 3 strategies |
| [Next.js: Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components) | Vercel | Boundary placement, interleaving via children, env poisoning |
| [Next.js: Fetching Data](https://nextjs.org/docs/app/getting-started/fetching-data) | Vercel | Fetch at the source, `React.cache`, client-fetch exceptions |
| [Next.js: Mutating Data](https://nextjs.org/docs/app/getting-started/mutating-data) | Vercel | Server Function placement and invocation |
| [Next.js: Backend for Frontend](https://nextjs.org/docs/app/guides/backend-for-frontend) | Vercel | Route Handlers' role; no RSC→route-handler fetching; actions ≠ reads |
| [Next.js: Authentication guide](https://nextjs.org/docs/app/guides/authentication) | Vercel | DAL implementation, `verifySession`, layouts-are-not-gates, Zod in actions |
| [Next.js: template.js](https://nextjs.org/docs/app/api-reference/file-conventions/template) | Vercel | Layout vs template semantics |
| [Next.js: Parallel Routes](https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes) | Vercel | Slots, conditional-route auth caveat, modal interception |
| [TypeScript Handbook: Enums → Objects vs Enums](https://www.typescriptlang.org/docs/handbook/enums.html#objects-vs-enums) | TypeScript team | "You may not need an enum"; `const enum` pitfalls |
| [TanStack Query: queryOptions](https://tanstack.com/query/latest/docs/framework/react/reference/queryOptions) | TanStack | `queryOptions` reference |
| [TanStack Query: Advanced Server Rendering](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr) | TanStack (TkDodo) | prefetch → dehydrate → HydrationBoundary; RSC = loader |

### Architecture guides & methodologies

| Source | Author/Org | Used for |
|---|---|---|
| [Bulletproof React: Project Structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) | Alan Alickovic | Feature folders, lib vs utils, unidirectional imports, anti-barrel stance |
| [Bulletproof React: react-vite ESLint config](https://github.com/alan2207/bulletproof-react/blob/master/apps/react-vite/.eslintrc.cjs) | Alan Alickovic | Working `import/no-restricted-paths` zones |
| [Feature-Sliced Design: Overview](https://feature-sliced.design/docs/get-started/overview) | FSD core team | Layers/slices/segments |
| [Feature-Sliced Design: Layers](https://feature-sliced.design/docs/reference/layers) | FSD core team | Downward-only import rule |
| [FSD v2.1 release ("Pages first")](https://github.com/feature-sliced/documentation/releases/tag/v2.1) | FSD core team | Start minimal; duplicate until real reuse |
| [FSD: Usage with Next.js](https://feature-sliced.design/docs/guides/tech/with-nextjs) | FSD core team | `app/` as thin routing shim; `index.server.ts` public APIs |
| [Modularizing React Applications](https://www.martinfowler.com/articles/modularizing-react-apps.html) | Juntao Qiu (martinfowler.com) | Layered React: views / hooks / domain models / data access |
| [patterns.dev: Presentational–Container](https://www.patterns.dev/react/presentational-container-pattern/) | patterns.dev | "Modern React strongly favors Hooks over container components" |
| [patterns.dev: Compound Pattern](https://www.patterns.dev/react/compound-pattern/) | patterns.dev | Compound components, tradeoffs |
| [How to Think About Security in Next.js](https://nextjs.org/blog/security-nextjs-server-components-actions) | Sebastian Markbåge (Vercel) | DAL, DTOs, taint APIs, Server Action security — canonical RSC security text |
| [Postmortem on Next.js Middleware bypass](https://vercel.com/blog/postmortem-on-next-js-middleware-bypass) | Vercel | CVE-2025-29927; middleware never the sole auth layer |

### Practitioner essays

| Source | Author | Used for |
|---|---|---|
| [Colocation](https://kentcdodds.com/blog/colocation) | Kent C. Dodds | Colocation principle, deleteability |
| [When to break up a component](https://kentcdodds.com/blog/when-to-break-up-a-component-into-multiple-components) | Kent C. Dodds | Split on real problems, never preemptively |
| [AHA Programming](https://kentcdodds.com/blog/aha-programming) | Kent C. Dodds | Avoid hasty abstractions |
| [State Colocation](https://kentcdodds.com/blog/state-colocation-will-make-your-react-app-faster) | Kent C. Dodds | State placement ladder |
| [Application State Management](https://kentcdodds.com/blog/application-state-management-with-react) | Kent C. Dodds | Server cache vs UI state split |
| [Prop Drilling](https://kentcdodds.com/blog/prop-drilling) | Kent C. Dodds | Prop drilling is often fine |
| [Smart and Dumb Components (+2019 retraction)](https://medium.com/@dan_abramov/smart-and-dumb-components-7ca2f9a7c7d0) | Dan Abramov | Container/presentational deprecated by its author |
| [The Wrong Abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) | Sandi Metz | "Duplication is far cheaper than the wrong abstraction" |
| [Practical React Query](https://tkdodo.eu/blog/practical-react-query) | Dominik Dorfmeister (TkDodo) | Server-state ownership; hooks around useQuery |
| [React Query as a State Manager](https://tkdodo.eu/blog/react-query-as-a-state-manager) | TkDodo | Async state manager; don't mirror server data |
| [Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys) | TkDodo | Per-feature colocated key factories |
| [The Query Options API](https://tkdodo.eu/blog/the-query-options-api) | TkDodo | `queryOptions` factories |
| [Component Composition is great btw](https://tkdodo.eu/blog/component-composition-is-great-btw) | TkDodo | Early returns + layout components |
| [Please Stop Using Barrel Files](https://tkdodo.eu/blog/please-stop-using-barrel-files) | TkDodo | Barrel harms; 11k→3.5k modules |
| [Working with Zustand](https://tkdodo.eu/blog/working-with-zustand) | TkDodo | Selectors, small stores |
| [You Might Not Need React Query](https://tkdodo.eu/blog/you-might-not-need-react-query) | TkDodo | When RSC replaces client fetching |
| [Delightful React File/Directory Structure](https://www.joshwcomeau.com/react/file-structure/) | Josh W. Comeau | Per-component directories; helpers vs utils |
| [React Folder Structure](https://www.robinwieruch.de/react-folder-structure/) | Robin Wieruch | 5-step structure evolution; promotion rule |
| [Feature-based React Architecture](https://www.robinwieruch.de/react-feature-architecture/) | Robin Wieruch | Vertical features with queries/actions |
| [Data Fetching with Server Actions](https://www.robinwieruch.de/next-server-actions-fetch-data/) | Robin Wieruch | queries vs actions split; actions-for-reads caveats |
| [Components Composition: How to Get It Right](https://www.developerway.com/posts/components-composition-how-to-get-it-right) | Nadia Makarevich | Extraction triggers; implement-or-compose rule |
| [Why I Don't Like TypeScript Enums](https://www.totaltypescript.com/why-i-dont-like-typescript-enums) | Matt Pocock | Enum pitfalls; `as const` + derived unions |

### Style guides, performance data & tooling

| Source | Author/Org | Used for |
|---|---|---|
| [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) | Google | CONSTANT_CASE scope, `const enum` ban, no default exports |
| [Airbnb JavaScript Style Guide §23.10](https://github.com/airbnb/javascript#naming--uppercase) | Airbnb | Uppercase only exported truly-immutable constants |
| [How we optimized package imports in Next.js](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js) | Shu Ding (Vercel) | Barrel import cost data |
| [Speeding up the JS ecosystem: the barrel file debacle](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/) | Marvin Hagemeister | Tooling cost of barrels |
| [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries) | Javier Brea | Declarative architectural linting |
| [React Folder Structure survey](https://profy.dev/article/react-folder-structure) | Johannes Kettmann | Real-world structure survey; types placement |

## Changelog

- **1.0.0** (2026-08-07) — initial version: project structure, decomposition,
  logic/state placement, constants/utils/types/API layer, Next.js App Router
  architecture (RSC boundaries, DAL, Server Actions, routing, middleware
  limits), enforcement rules.
