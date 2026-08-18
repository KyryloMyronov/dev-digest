---
name: onion-architecture
description: "Onion Architecture for the DevDigest backend (server/ + reviewer-core/). Use when deciding WHERE backend code lives and WHICH direction a dependency may point: adding a module, service, repository, adapter or port; wiring a third-party SDK; placing business logic; choosing what a route may know. Covers the dependency rule, ports/adapters, the composition root, and how Fastify/Drizzle/Zod/Octokit/LLM SDKs map onto the rings. Does NOT cover Fastify API mechanics (fastify-best-practices), Drizzle query syntax (drizzle-orm-patterns), table design (postgresql-table-design), or frontend structure (frontend-ui-architecture)."
version: 1.0.0
---

# Onion Architecture (backend)

Architecture and dependency rules for `server/` and `reviewer-core/`. Grounded
in Jeffrey Palermo's original four tenets (2008) and the Onion/Clean/Hexagonal
consensus, adapted to what this repo actually is — a modular monolith whose
slices have layers *inside* them. Sources: [README.md](README.md). Code shapes:
[examples.md](examples.md).

**The one meta-rule** (Palermo): *all code can depend on layers more central,
but code cannot depend on layers further out.* When an inner ring needs an
outer capability, you do not import outward — you declare an interface in the
inner ring and let the outer ring implement it. The database is not the
center; it is external.

Half of this document is executable. `cd server && pnpm lint:arch` enforces the
dependency rule via `server/.dependency-cruiser.cjs`. Rule names in **bold
monospace** below are the lint rules that check them.

---

## 1. The rings, mapped to this repo

Innermost first. A ring may import itself and anything above it in this table,
never below.

| # | Ring | Lives in | Contains |
|---|---|---|---|
| 1 | Domain core | `reviewer-core/src/` | Pure review engine: prompt assembly, grounding, map-reduce. No DB, no HTTP, no framework. |
| 2 | Ports & contracts | `server/src/vendor/shared/` | `adapters.ts` (interfaces) + `contracts/` (Zod schemas). Declarations only, zero implementation. |
| 3 | Application | `server/src/modules/<name>/service.ts` | Use-case orchestration. Depends on ports, never on concretions. |
| 4 | Infrastructure | `server/src/adapters/**`, `modules/*/repository*.ts`, `server/src/db/**` | Implements ring 2. The only place `drizzle-orm` and I/O SDKs appear. |
| 5 | Presentation | `server/src/modules/*/routes.ts` | Fastify plugins. Transport only. |
| — | Composition root | `server/src/platform/container.ts` | Exempt by design: the one place that knows every concretion. |

`server/src/platform/**` is cross-cutting infrastructure (jobs, SSE, config,
errors, resilience). It may not import a feature module — **`no-module-imports-from-platform`**.
`container.ts` is the sole exception.

The full walkthrough of "one HTTP request through all five rings" is in
[examples.md](examples.md).

## 2. Ports — start every external capability here

- **A new external capability begins as an interface in
  `server/src/vendor/shared/adapters.ts`**, before any implementation exists.
  Name it for the *domain* need (`GitHubClient`, `Embedder`, `CodeIndex`), not
  for the vendor (`OctokitWrapper`).
- **Ports are persistence- and transport-ignorant.** No `FastifyRequest`, no
  Drizzle query builder, no vendor error type in a signature. If the interface
  would have to change when you swap the vendor, it is not a port.
- **Wire-shape types are Zod schemas in `vendor/shared/contracts/`**, one file
  per bounded area. The schema serves request validation *and* response
  serialization — declare it on the route, never hand-validate in a service.
- **`vendor/shared/` must not import anything that implements it** —
  **`no-server-imports-from-shared`**. If a port needs a type from a module,
  the type belongs in `contracts/`.
- `server/src/vendor/shared/` is **canonical**; `client/src/vendor/shared/` is a
  hand-synced copy. A contract change lands in both or the client's types
  silently disagree with the wire format.

## 3. Domain core (`reviewer-core`)

- **No I/O, no framework, no clock, no randomness reaching out.** Pure
  functions over their arguments. This is why the review engine is testable
  without Docker and reusable by the CI runner.
- It may import ring 2 (`@devdigest/shared`) — that is inward. It may not
  import a module, adapter, platform service or the DB —
  **`no-core-imports-from-server`**.
- **Business rules that are about *reviewing* go here**, not into a service. A
  service that grows a pure algorithm should push it down into `reviewer-core`
  or a sibling pure module (`modules/reviews/helpers.ts` is the local pattern:
  side-effect free, no `this`).

## 4. Adapters — the outer edge

- **One folder per port** under `server/src/adapters/<capability>/`, named for
  the vendor (`github/octokit.ts`, `llm/anthropic.ts`, `git/simple-git.ts`).
- **Only I/O and process-boundary libraries need a port.** `octokit`,
  `simple-git`, `@ast-grep/napi`, `openai`, `@anthropic-ai/sdk`, `postgres`,
  `@vscode/ripgrep`, `dependency-cruiser` are behind adapters —
  **`no-vendor-sdks-outside-adapters`**. Pure computation libraries (`zod`,
  `graphology`, `p-queue`, `js-tiktoken`) are *not* adapters; they are
  language-level tools and may be imported from any ring. Wrapping a pure
  library buys nothing and costs a layer.
- **Adapters hold no business rules.** Translate, call, translate back. If you
  are making a decision, it belongs in a service.
- **Translate foreign failures into `AppError` subclasses** from
  `platform/errors.ts` (`ExternalServiceError`, `ConfigError`, …). A raw
  Octokit or OpenAI error must never escape an adapter — the rings above must
  not learn the vendor's error taxonomy.
- **Optional infrastructure degrades, it does not throw.** `container.repoIntel`
  is the sanctioned pattern: array methods return `[]`, object methods carry
  `degraded`, and callers treat empty as "no enrichment" rather than an error.
  Use a facade like this whenever a capability may be switched off in config.

## 5. Application services

- **Constructor-inject the `Container`; resolve every dependency from it.**
  Never `new` an adapter inline — tests replace adapters through
  `ContainerOverrides`, which only works if you do.
- **A service must be callable without an HTTP request.** No `FastifyRequest`,
  `FastifyReply` or `fastify` import below `routes.ts` —
  **`no-fastify-below-routes`**. This is the property that makes services unit
  testable with no server and no Docker.
- **No SQL and no `drizzle-orm` import** — **`no-drizzle-outside-persistence`**.
  Data comes from a repository.
- **Return DTOs, never Drizzle rows.** Row types are an infrastructure detail;
  leaking them couples the API surface to the table shape and makes a column
  rename a breaking wire change.
- **Anything slow goes through `JobRunner`** (clone, index, poll), not the
  request.
- **Modules do not call each other's services** —
  **`no-cross-module-internals`**. A module's public surface is exactly its
  `constants.ts` (job kinds) and `types.ts` (facade interface); its `service`,
  `repository`, `routes` and helpers are private. Cross-module work is
  enqueued by job kind (`repos/service.ts` enqueuing `INDEX_JOB_KIND` is the
  reference), and shared entities are exposed on the container
  (`container.agentsRepo`, `container.reviewRepo`, `container.repoIntel`).

## 6. Repositories

- **The only consumers of `drizzle-orm` outside `src/db/`.** One repository
  owns one aggregate's tables and is the sole code that touches them
  (`modules/repos/repository.ts` states this explicitly and is the model).
- **One repository per aggregate, not per table.** `modules/reviews/repository/`
  splits into `review.repo.ts` / `pull.repo.ts` / `run.repo.ts` because those
  are three aggregates, not because there are three tables.
- **Every query is scoped by `workspaceId`.** Take it as the first parameter;
  a repository method without it is a tenancy bug.
- **Return rows or DTOs, never a query builder.** Handing a partially-built
  Drizzle query to a service re-couples the ring you just decoupled — this is
  the `IQueryable` leak in TypeScript form.
- **Map row → DTO at the boundary**, in a pure sibling module
  (`modules/reviews/helpers.ts`: `findingRowToDto`, `reviewToDto`). API types,
  domain types and row types are three distinct things that evolve separately.
- **No presentation concerns.** Sorting and pagination are parameters the
  caller passes, not policy the repository invents.
- **Transactions are the repository's job.** Use `db.transaction` inside the
  method that needs atomicity; do not expose a Unit-of-Work abstraction —
  Drizzle has no first-class one and a hand-rolled one leaks the ORM upward.

## 7. Routes

- **Transport only: parse → delegate → map status code.** `modules/repos/routes.ts`
  is the reference — every handler is three lines.
- **No business logic, no `drizzle-orm`, no `db/schema` import** —
  **`no-db-schema-above-repository`**.
- **One Zod schema per route** for body/params/response, from `contracts/`.
- **Throw `AppError` subclasses**; the single handler in `app.ts` maps them to
  the `{error:{code,message,details}}` envelope. Never build that envelope by
  hand.
- **Resolve tenancy with `getContext(container, req)`** (`modules/_shared/context.ts`)
  and pass `workspaceId` down explicitly. Never let a service read the request.
- **A route is a Fastify plugin**, registered statically in `modules/index.ts` —
  one folder + one import + one registry entry, and nothing else changes.

## 8. Composition root

- `platform/container.ts` is the **only** place concretions are constructed.
  Adapters are lazy getters (`this._git ??= new SimpleGitClient(...)`) so an
  unused capability never builds a client — `container.embedder()` deliberately
  throws before constructing anything when `EMBEDDINGS_ENABLED` is false.
- **Overrides come first, always**: `if (this.overrides.git) return this.overrides.git;`
  Tests inject mocks via `ContainerOverrides`.
- **We do not use a DI library.** A hand-written container of ~15 lazy getters
  is the composition root; `@fastify/awilix` and friends add a registration
  DSL and runtime resolution errors in exchange for nothing we need at this
  size. Revisit only if the container stops fitting on one screen.
- A service importing `type { Container }` from the root that constructs it is
  **not** a cycle — it erases at compile time, and `no-circular` excludes
  type-only edges deliberately.

## 9. The stack, ring by ring

| Tool | Ring | Rule |
|---|---|---|
| **Fastify** | 5 | Plugins *are* the presentation ring. Decorate the instance (`app.container`), never reach for a module-level global. Nothing below `routes.ts` imports it. |
| **Zod** | 2 | Contracts are the shape of the domain, so `zod` is allowed in every ring. Validate at the edge only — a service receiving validated input must not re-parse it. Beware the cross-package `instanceof` trap (`app.ts:138`). |
| **Drizzle** | 4 | `db/schema/**` is infrastructure. Generate migrations with `pnpm db:generate`; never hand-edit. Schema types stop at the repository. |
| **Postgres / pgvector** | 4 | Behind the repository. `workspace_id` on every domain table, scoped in every query. |
| **Pino** | cross-cutting | Inject a logger (`run-executor.ts` takes a `Logger`); the core must not import one. Log at the edge where you have the request context. |
| **Octokit, simple-git, ast-grep, ripgrep** | 4 | Behind `GitHubClient` / `GitClient` / `CodeIndex` ports. |
| **OpenAI / Anthropic / OpenRouter** | 4 | Behind `LLMProvider`. Model choice and pricing are config (`platform/model-router.ts`, `price-book.ts`), not hard-coded in a service. |
| **JobRunner** | cross-cutting | The async seam between modules. Job kinds are a module's published contract. |
| **Vitest** | — | Unit tests construct a service with a `Container` full of mock ports — no server, no Docker. `*.it.test.ts` = DB-backed via testcontainers. Membership is by filename. |

## 10. Where new backend code goes

| You are adding… | It goes to… |
|---|---|
| A call to any external system | a port in `vendor/shared/adapters.ts` + an impl in `adapters/<capability>/` |
| A wire type (request/response) | `vendor/shared/contracts/` — and mirror into `client/src/vendor/shared/` |
| A use case / orchestration | `modules/<name>/service.ts` |
| A pure rule about *reviewing* | `reviewer-core/src/` |
| A pure helper for one module | `modules/<name>/helpers.ts` (no `this`, no I/O) |
| A query | `modules/<name>/repository.ts`, `workspaceId` first |
| A table | `db/schema/<area>.ts` + `pnpm db:generate` |
| An HTTP endpoint | `modules/<name>/routes.ts` + registry entry in `modules/index.ts` |
| Something slow | a `JobRunner` kind, with the constant in `modules/<name>/constants.ts` |
| A new error case | an `AppError` subclass in `platform/errors.ts` |
| Wiring a new adapter | a lazy getter + `ContainerOverrides` field in `platform/container.ts` |
| Something two modules need | the container (shared repo/facade) or a job kind — never a cross-module import |

## 11. Enforcement

```sh
cd server && pnpm lint:arch          # exits non-zero on errors, 0 on warnings
cd server && pnpm lint:arch:graph    # dot output for a visual ring check
```

Rules live in [`server/.dependency-cruiser.cjs`](../../../server/.dependency-cruiser.cjs).
`dependency-cruiser` is already a runtime dependency (`adapters/depgraph/`
uses it on user repos), so this adds no install. `eslint-plugin-boundaries` is
the usual alternative — not used here because the repo has no ESLint setup.

**Reading a violation**: the rule name tells you which ring you crossed and
the `comment` field in the config says what to do instead. The fix is almost
never "add an exception" — it is to introduce the missing port, repository or
job kind.

## 12. Known deviations and current debt

Honest state of the code. Do not treat these as precedent.

- **All eight modules now layer `routes → service → repository`**, and
  `pnpm lint:arch` reports zero violations at full severity. The last four to
  be refactored were `pulls` (381 lines → 52), `settings`, `polling` and
  `workspace`. The refactor path, if a fat route ever reappears: extract
  `repository.ts` (queries + `workspaceId` scoping) → extract `service.ts`
  (the decisions) → reduce the route to parse/delegate → add unit tests for the
  pure mappers that extraction just made reachable (`test/pulls-helpers.test.ts`
  is the worked example).
- **`pull_requests` is written by two modules** — `pulls` owns it, `polling`
  syncs it. Rather than let `polling` reach into another module's folder, the
  repository is exposed as `container.pullsRepo`, the same seam as
  `container.agentsRepo` / `container.reviewRepo`. One table still has exactly
  one repository.
- **`reviewer-core` exports `OpenRouterProvider`** (`reviewer-core/src/llm/openrouter.ts`),
  an adapter living inside the domain core so the CI runner can use it without
  the server. A pragmatic deviation, not a pattern to copy: new adapters go in
  `server/src/adapters/`.
- **`platform/jobs.ts`, `adapters/auth/local.ts`, `app.ts` and
  `settings/feature-models.ts` import `drizzle-orm`** outside a repository —
  each owns its own narrow table access and is allow-listed in the config.
  Prefer a repository for anything new.
- **Stale-run reaping assumes one API instance per DB** (`app.ts:81`) — an
  infrastructure assumption, not an architectural one, but it blocks replicas.

## 13. Why Onion here (and not the alternatives)

The repo is a **modular monolith**: `modules/<name>/` is a vertical slice, and
the rings live *inside* the slice. That is the mainstream 2025 position —
slices for the top-level organizing principle, layers within them — and it is
why `no-cross-module-internals` (a slice rule) matters as much as
`no-drizzle-outside-persistence` (a ring rule).

Onion, Clean and Hexagonal are siblings, not rivals: all three say source
dependencies point inward and business logic is isolated from infrastructure.
We use Onion's vocabulary because its ring model matches our folders and
because it puts *repository interfaces in the core* — exactly what
`vendor/shared/adapters.ts` is. We deliberately stop short of full DDD
tactical patterns: there are no entities, value objects or aggregate roots in
this codebase, and adding them speculatively would be a rewrite. If a module
ever grows genuine invariants spread across several rows, that is the moment
to introduce an aggregate — see the DDD references in [README.md](README.md).
