# Onion Architecture — code shapes

Companion to [SKILL.md](SKILL.md). Every ✅ shape is real code in this repo,
cited by path. Every ❌ is a pattern the architecture lint rejects.

---

## One request through all five rings

`POST /repos` — the `repos` module is the reference implementation.

```
routes.ts        parse RepoInput, getContext(), delegate, set 201/200
  └─ service.ts  decide: dedupe by fullName? insert? enqueue a clone job?
       ├─ repository.ts   the only code touching the `repos` table
       └─ container.git   GitClient port → adapters/git/simple-git.ts
```

```ts
// server/src/modules/repos/routes.ts — ring 5, transport only
app.post('/repos', { schema: { body: RepoInput } }, async (req, reply) => {
  const { workspaceId, userId } = await getContext(app.container, req);
  const { repo, created } = await service.add(workspaceId, userId, req.body.url);
  reply.status(created ? 201 : 200);
  return repo;
});
```

Three lines: resolve tenancy, delegate, map the status code. No `if`, no query,
no knowledge of what "add a repo" means.

---

## Ports and adapters

### ✅ The port names the need, not the vendor

```ts
// server/src/vendor/shared/adapters.ts — ring 2
export interface LLMProvider {
  readonly id: 'openai' | 'anthropic' | 'openrouter';
  listModels(): Promise<ModelInfo[]>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  embed(texts: string[]): Promise<number[][]>;
}
```

Nothing in this signature reveals OpenAI, Anthropic or HTTP. Swapping the
vendor changes one file in `adapters/llm/`.

### ❌ A port that leaks its implementation

```ts
// Not a port — the vendor's types are in the signature.
export interface GitHubClient {
  octokit: Octokit;                                  // ❌ vendor object
  listPulls(o: Octokit.PullsListParams): Promise<Octokit.PullsListResponse>;
}
```

If replacing the vendor forces the interface to change, the interface is not
an abstraction. `no-vendor-sdks-outside-adapters` catches the import; nothing
catches a bad interface but review.

### ❌ Reaching for the SDK from a module

```ts
// server/src/modules/repos/service.ts
import { Octokit } from 'octokit';                   // ❌ ring 3 importing ring 4
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
```

```
error no-vendor-sdks-outside-adapters: src/modules/repos/service.ts → node_modules/octokit
```

✅ Instead: `const pulls = await this.container.github.listPulls(ref)`.

### Not everything needs a port

`zod`, `graphology`, `p-queue` and `js-tiktoken` are pure computation — no
sockets, no filesystem, no clock. They may be imported from any ring. Wrapping
them buys no substitutability and costs an indirection. The test: *would a unit
test need to mock it?* If no, it is not an adapter.

---

## Services

### ✅ Dependencies resolved from the container

```ts
// server/src/modules/reviews/service.ts — ring 3
export class ReviewService {
  private repo: ReviewRepository;
  private agents: Container['agentsRepo'];

  constructor(private container: Container) {
    this.repo = new ReviewRepository(container.db);
    this.agents = container.agentsRepo;              // shared repo from the root
  }
}
```

`agentsRepo` comes off the container rather than from
`import { AgentsRepository } from '../agents/repository.js'` — that import
would be a cross-slice reach into another module's internals.

### ❌ HTTP types below the route

```ts
// server/src/modules/repos/service.ts
import type { FastifyRequest } from 'fastify';       // ❌
async add(req: FastifyRequest) {
  const workspaceId = await this.container.auth.currentWorkspace(req);
  …
}
```

```
error no-fastify-below-routes: src/modules/repos/service.ts → node_modules/fastify
```

This is the rule with the most practical payoff: a service that takes
`workspaceId: string` is unit-testable with no server; one that takes a
`FastifyRequest` needs a whole HTTP stack to call.

### ❌ Calling another module's service

```ts
import { ReviewService } from '../reviews/service.js';   // ❌
await new ReviewService(this.container).run(prId);
```

```
error no-cross-module-internals: src/modules/repos/service.ts → src/modules/reviews/service.ts
```

✅ Instead — enqueue by job kind. The importing module learns only a constant:

```ts
// server/src/modules/repos/service.ts
import { INDEX_JOB_KIND } from '../repo-intel/constants.js';   // ✅ public surface
await this.container.jobs.enqueue(INDEX_JOB_KIND, { repoId });
```

A module's public surface is exactly `constants.ts` and `types.ts`. Everything
else in the folder is private.

---

## Repositories

### ✅ Aggregate-scoped, tenancy-scoped, row-typed

```ts
// server/src/modules/repos/repository.ts — ring 4
/**
 * F1 — repos data-access layer. The ONLY place that touches the `repos`
 * table. Every query is scoped by `workspaceId` (tenancy guard).
 */
export class RepoRepository {
  constructor(private db: Db) {}

  async getById(workspaceId: string, id: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, id)));
    return row;
  }
}
```

`workspaceId` is the first parameter of every method. A method without it is a
tenancy bug waiting to happen, not a convenience.

### ❌ Returning a query builder

```ts
// Re-couples the caller to Drizzle — the TypeScript form of the IQueryable leak.
listQuery(workspaceId: string) {
  return this.db.select().from(t.repos).where(eq(t.repos.workspaceId, workspaceId));
}
// caller, ring 3:
const repos = await repo.listQuery(ws).orderBy(desc(t.repos.createdAt)).limit(10);  // ❌
```

✅ Instead, take the intent as parameters and return data:
`list(workspaceId, { limit, order })`.

### ✅ Row → DTO at the boundary, in a pure module

```ts
// server/src/modules/reviews/helpers.ts — no `this`, no I/O, no DB
export function findingRowToDto(row: FindingRow): ReviewDtoFinding {
  return {
    id: row.id,
    severity: row.severity as Finding['severity'],
    start_line: row.startLine,        // snake_case wire shape ≠ camelCase row
    end_line: row.endLine,
    suggestion: row.suggestion ?? null,
    …
  };
}
```

Row types, domain types and wire types are three things. This function is where
they are allowed to meet. Returning `FindingRow` straight from a service would
make a column rename a breaking API change.

---

## Composition root

### ✅ Lazy, override-first

```ts
// server/src/platform/container.ts
get git(): GitClient {
  if (this.overrides.git) return this.overrides.git;   // tests win
  this._git ??= new SimpleGitClient(this.config.cloneDir);
  return this._git;
}
```

Override check first, then lazy construction. `container.embedder()` goes
further and throws `ConfigError` before constructing an OpenAI client when
`EMBEDDINGS_ENABLED` is false — zero requests are made, by design.

### ✅ Tests inject through the seam

```ts
const container = new Container(config, db, {
  github: mockGitHubClient,
  llm: { openai: mockProvider },
});
const service = new ReviewService(container);   // no network, no Docker
```

This only works because nothing below `routes.ts` constructs an adapter inline.

### ✅ Degrading facade for optional infrastructure

```ts
// container.repoIntel — never throws; callers treat empty as "no enrichment"
const symbols = await container.repoIntel.findSymbols(repoId, names);
if (symbols.length === 0) {
  // no enrichment available — proceed with the plain diff, do not fail the review
}
```

---

## Type-only imports are not cycles

```ts
// server/src/modules/repo-intel/service.ts
import type { Container } from '../../platform/container.js';   // ✅ erases at compile time
```

The container constructs `RepoIntelService`, and the service imports the
container's *type*. `no-circular` uses `viaOnly: { dependencyTypesNot: ['type-only'] }`
so this DI shape does not register as a cycle. A cycle made of real value
imports still fails — and means a ring boundary was crossed in both directions.

---

## What extraction buys — the pulls refactor

`modules/pulls/routes.ts` used to be 381 lines with Drizzle queries inline:

```ts
// BEFORE — ring 5 doing ring 4's job
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import * as t from '../../db/schema.js';

app.get('/repos/:id/pulls', …, async (req) => {
  const [repo] = await container.db.select().from(t.repos).where(…);   // ❌
  // …150 more lines: GitHub sync, diff-stat backfill, three rollup
  //    queries, and the row → wire mapping, all in the handler
});
```

It is now 52 lines of parse-and-delegate, over `service.ts` (orchestration),
`repository.ts` (every query) and `helpers.ts` (pure mapping).

The payoff is not tidiness — it is **reachability**. The row → wire mapping was
untestable while it lived inside a route closure; extracted, it takes nine unit
tests with no DB, no HTTP and no GitHub (`server/test/pulls-helpers.test.ts`):

```ts
it('keeps reviewed-and-clean distinct from never-reviewed', () => {
  const meta = prRowToMeta(BASE, { score: 100, costUsd: 0, findings: ZERO }, NOW);
  // All-zero counts are a real answer ("we looked, it was clean"), so the
  // object must survive rather than collapse to null.
  expect(meta.findings).toEqual({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
  expect(meta.cost_usd).toBe(0);   // 0 is a cost, not "unknown"
});
```

That distinction — `null` vs `0`, never-reviewed vs reviewed-and-clean — is
exactly the kind of rule that rots silently when it is buried in a handler.

## Sharing a table across modules

`pull_requests` is owned by `pulls`, but `polling` syncs it too. The wrong fix
is an import across module folders:

```ts
// server/src/modules/polling/service.ts
import { PullsRepository } from '../pulls/repository.js';   // ❌ private surface
```

```
error no-cross-module-internals: src/modules/polling/service.ts → src/modules/pulls/repository.ts
```

✅ Expose it on the composition root instead — the same seam `agentsRepo` and
`reviewRepo` already use:

```ts
// server/src/platform/container.ts
get pullsRepo(): PullsRepository {
  return (this._pullsRepo ??= new PullsRepository(this.db));
}

// server/src/modules/polling/service.ts
await this.container.pullsRepo.upsertPull({ … });   // ✅ one table, one repository
```
