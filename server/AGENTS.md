# `@devdigest/api` — server

Fastify + Postgres engine. Request/DI flow, API map, environment variables, and
review-context details: [`README.md`](README.md). Root rules: [`../CLAUDE.md`](../CLAUDE.md).

## Stack additions

Beyond the root stack: `@fastify/{helmet,cors,rate-limit}` · `fastify-sse-v2` ·
`octokit` 4 · `simple-git` 3 · `@ast-grep/napi` 0.43 (pinned, native) ·
`dependency-cruiser` 17 · `graphology` 0.26 · `@vscode/ripgrep` ·
`js-tiktoken` · `p-queue` 8 · testcontainers 10.

## Commands

```sh
pnpm dev                                          # tsx watch, :3001
pnpm db:migrate                                   # required after a fresh clone or new migration
pnpm db:generate                                  # drizzle-kit — generates the SQL, never hand-write it
pnpm db:seed                                      # idempotent demo data
pnpm lint:arch                                    # architecture lint (Onion dependency rule)
pnpm test                                         # both suites
pnpm exec vitest run --exclude '**/*.it.test.ts'  # unit only (hermetic, no Docker)
pnpm exec vitest run .it.test                     # integration only (testcontainers Postgres)
```

## Where things live

```
src/modules/<name>/    one feature = one Fastify plugin (routes → service → repository)
src/adapters/          the outside world, behind interfaces declared in shared
src/platform/          cross-cutting: container, jobs, sse, config, errors, resilience
src/db/                schema (13 domain files + barrel), migrations, seed
src/vendor/shared/     @devdigest/shared — CANONICAL copy of the Zod contracts
src/prompts/           prompt bodies shipped as .md
```

## Non-default conventions

**Architecture is a skill, and it is enforced.** The full ring model, the
"where does this code go" table, and the rationale live in
[`.claude/skills/onion-architecture/`](../.claude/skills/onion-architecture/SKILL.md).
Run `pnpm lint:arch` before you commit — it fails on a crossed boundary. The
headlines:

- **Layering is one-directional: `routes.ts` → `service.ts` → `repository.ts`.**
  Routes are transport only — parse, map status codes, delegate. No business
  logic in a route, no HTTP types below it.
- **Third-party I/O libraries only inside `adapters/`, behind a `shared`
  interface.** Nothing outside `adapters/` imports `octokit`, `simple-git`,
  `@ast-grep/napi`, `dependency-cruiser`, or an LLM SDK directly. Pure
  computation libraries (`zod`, `graphology`, `p-queue`) are not adapters and
  need no port.
- **A module's public surface is its `constants.ts` (job kinds) and
  `types.ts`.** Its service, repository and routes are private to it —
  cross-module work goes through the container or a job kind.
- **`repo-intel` is reachable only through the `RepoIntel` facade**
  (`container.repoIntel`) — never its libraries. It degrades instead of throwing:
  array methods return `[]`, object methods carry `degraded`. Callers must treat
  empty as "no enrichment", not as an error.
- **Resolve every dependency from `container`**, never construct an adapter
  inline. Tests inject mocks via `ContainerOverrides`, which only works if you do.
- **Modules are registered statically** in `src/modules/index.ts` — deliberately
  not `@fastify/autoload`, so the same path works under tsx, bundlers, and
  vitest. Adding a module = one new folder + one import + one registry entry, and
  nothing else changes.
- **One Zod schema serves request validation AND response serialization.**
  Declare it on the route; don't hand-validate in the service.
- **Errors: throw `AppError` subclasses.** The single handler in `app.ts` maps
  them to the `{error:{code,message,details}}` envelope. Never build that
  envelope by hand in a route.
- **Anything slow goes through `JobRunner`** (clone, index, poll), not the
  request. Modules communicate by job kind, not by calling each other's services.
- **Test-suite membership is by filename**: `*.it.test.ts` = DB-backed
  integration (needs Docker); everything else must be hermetic.

## Gotchas

- **The zod `instanceof` trap.** `server` and `reviewer-core` can resolve
  *different* zod instances, so `err instanceof z.ZodError` is unreliable across
  that boundary. `app.ts:138` matches by shape as well — don't "simplify" it.
- **Stale-run reaping assumes a single API instance per DB** (`app.ts:81`). With
  replicas it would reap live runs; it needs per-instance heartbeats first.
- **`container.embedder()` throws when `EMBEDDINGS_ENABLED` is false** — by
  design, before constructing any OpenAI client, so zero requests are made.
  Every caller must catch and degrade.
- **`invalidateSecretCaches()` after persisting a key**, or providers keep using
  the old one for the process lifetime.
- Rate limiting is disabled under `NODE_ENV=test` so integration suites can
  hammer `inject()`.

## Do-not-touch

- `clones/**` — scratch clones, gitignored, contains a copy of this repo.
- `src/db/migrations/**` — drizzle-kit output; generate, don't edit.
- `src/vendor/shared/**` — canonical, but any change must be mirrored into
  `client/src/vendor/shared/`.

## Docs

Request & DI flow, API map, env vars → [`README.md`](README.md) ·
Indexer pipeline & facade → [`src/modules/repo-intel/README.md`](src/modules/repo-intel/README.md) ·
Testing strategy → [`../TESTING.md`](../TESTING.md) ·
Prompt authoring → [`../docs/agent-prompts/`](../docs/agent-prompts/README.md) ·
Learned gotchas → [`insights.md`](insights.md) · Unbuilt work → [`specs/`](specs/README.md)

Relevant skills: `onion-architecture` (read first — it decides *where* code
goes), then `fastify-best-practices`, `drizzle-orm-patterns`,
`postgresql-table-design`, `zod`.