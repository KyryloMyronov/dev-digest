# DevDigest

Local-first AI pull-request reviewer. Also the starter template for a course —
see [`README.md`](README.md) for purpose, the architecture diagram, and the
lesson roadmap. **Read that before designing anything; it is not repeated here.**

## Stack

| | |
|---|---|
| Runtime | Node ≥ 22 · TypeScript 5.7 · ESM everywhere |
| Package managers | **pnpm 11** in `server/`, `client/` · **npm** in `reviewer-core/`, `e2e/` |
| API | Fastify 5 · Zod 3 · `fastify-type-provider-zod` 4 · Pino |
| DB | Postgres 16 + pgvector (Docker) · Drizzle ORM 0.38 · drizzle-kit 0.30 · postgres.js 3.4 |
| Web | Next.js 15 (App Router) · React 19 · TanStack Query 5 · Tailwind 4 |
| LLM | `openai` 4 · `@anthropic-ai/sdk` 0.33 · OpenRouter (OpenAI-compatible) |
| Tests | Vitest 2.1 (×3 suites) · testcontainers 10 · agent-browser (e2e) |

## Commands

```sh
./scripts/dev.sh                 # zero → running: Postgres, .env, deps, migrate, seed, API+web
./scripts/dev.sh --db-only       # also: --no-seed, --no-client, --help
./scripts/e2e.sh                 # hermetic e2e on alternate ports (safe alongside dev)
./scripts/check-contracts.sh     # fails if the client's shared mirror drifted (--fix to sync)

cd server && pnpm dev|build|typecheck|test
cd server && pnpm db:migrate|db:seed|db:generate
cd client && pnpm dev|build|typecheck|test
cd reviewer-core && npm ci && npm run typecheck|test
cd e2e && npm install && npm test
```

Ports: web **3000** · API **3001** · Postgres **5432**. Hermetic e2e: 3100/3101/5433.

## Where things live

```
server/         @devdigest/api — Fastify, Postgres, adapters, jobs        :3001
client/         @devdigest/web — Next.js studio                          :3000
reviewer-core/  @devdigest/reviewer-core — pure review engine, no I/O
e2e/            @devdigest/e2e — deterministic browser flows
docs/           cross-cutting docs (agent-prompt authoring)
scripts/        dev.sh, e2e.sh
```

`@devdigest/shared` (Zod contracts) has no folder of its own — it lives at
`server/src/vendor/shared/`. `repo-intel` (the indexer) lives inside the server
at `server/src/modules/repo-intel/`.

## Insights — read at the start, write at the end

- **Before your first edit**, read the `insights.md` of the package the task
  touches, plus the root [`insights.md`](insights.md) for cross-cutting ones.
  Treat entries as high-confidence guidance unless something says otherwise. If
  an entry contradicts the code as it stands now, the code wins and the entry is
  stale — say so rather than following it.
- **At the end of a substantive session**, run `/engineering-insights` to
  capture what was learned. Don't skip this step. It writes nothing when nothing
  substantial happened — that is the normal outcome, not a failure.

Writes are strictly append-only: never overwrite, reflow, or delete an existing
entry; supersede it with a new one instead. Full procedure and the seven rubrics:
[`.claude/skills/engineering-insights/`](.claude/skills/engineering-insights/SKILL.md).

## Non-default conventions

- **Four standalone packages, NOT a pnpm workspace.** Each has its own
  `package.json` and lockfile. Cross-package code is shared as TypeScript
  **source** through tsconfig path aliases — there is no build or publish step
  for shared code. Never `pnpm add` one local package into another.
- **Two package managers on purpose.** `server`/`client` use pnpm;
  `reviewer-core`/`e2e` use npm (`package-lock.json`). Don't unify them without
  reading `scripts/dev.sh:77-80`.
- **`@devdigest/shared` is canonical at `server/src/vendor/shared/`.**
  `client/src/vendor/shared/` is a **hand-synced copy**. A contract change must
  land in both, or the client's types silently disagree with the wire format.
  `./scripts/check-contracts.sh` enforces this (CI: `contracts.yml`); sync with
  `--fix`, which always copies server → client. Both packages type-check
  against their own copy, so nothing else catches the drift.
- Every domain table carries `workspace_id`; all queries scope by it.

## Gotchas

- **Migrations do NOT run on boot.** `cd server && pnpm db:migrate`. First-run
  `relation ... does not exist` is always this.
- **Docker runs Postgres only.** API and web run on the host.
- **`reviewer-core/node_modules` must exist or the API won't boot** — the API
  imports its raw source at runtime, so missing deps surface as
  `ERR_MODULE_NOT_FOUND` from `server`, not from `reviewer-core`.
- **pnpm 11 blocks dependency build scripts.** New native deps need an
  `allowBuilds:` entry in that package's `pnpm-workspace.yaml`, else install
  fails with `ERR_PNPM_IGNORED_BUILDS`. Fill it in — a placeholder string counts
  as unapproved.
- **This is a course starter: schema and contracts exist ahead of the features
  that use them.** ~35 tables, many with no module behind them yet (`eval`,
  `ci`, `memory`, `plugins`, `digests`). Unused ≠ dead. Do not
  "clean up" the schema or the contract barrel. (`skills` / `skill_versions` /
  `agent_skills` are no longer in that list — the skills module owns them.)
- Reset everything: `docker compose down -v`, then `./scripts/dev.sh`.

## Do-not-touch

| Path | Why |
|---|---|
| `server/clones/**` | Gitignored scratch clones of user repos. **Currently contains a full copy of this repo** — files there look real and are not. Never read, edit, or search it. |
| `server/src/db/migrations/**` | drizzle-kit output. Add a migration via `pnpm db:generate`; never hand-edit an applied one. |
| `.claude/skills/**` | The skills listed in `skills-lock.json` are vendored from upstream and hash-locked — local edits get overwritten. Skills authored here (`engineering-insights`) are **not** locked and are yours to edit. |
| `client/src/vendor/**` | Mirror of `shared` + the UI kit. Change the source, then sync. |
| `dist/`, `.next/`, `*.tsbuildinfo`, `coverage/` | Generated. |

## Docs

| Topic | Where |
|---|---|
| Purpose, architecture, quick start, lesson roadmap | [`README.md`](README.md) |
| Testing & CI strategy, suite map | [`TESTING.md`](TESTING.md) |
| Writing agent prompts, prompt slot order, model choice | [`docs/agent-prompts/`](docs/agent-prompts/README.md) |
| Per-package rules | `server/`, `client/`, `reviewer-core/`, `e2e/` → `CLAUDE.md` |

Each package also has `docs/` (explanations), `specs/` (intent for unbuilt work),
and `insights.md` (accumulated gotchas). Cross-cutting gotchas — `scripts/`,
CI, root configs, or a fix spanning two packages — go in the root
[`insights.md`](insights.md). See **Insights** above for when to read and write.