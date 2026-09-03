import type { SkillCase } from "../../src/index.js";

// This skill's job is to judge WHERE backend code lives and WHICH way a dependency points.
// Each case inlines a small server/reviewer-core code snippet the skill can reason over
// directly — standing in for what the skill would normally read itself with Read/Grep — and
// asks it to review that snippet against the Onion rules in SKILL.md.

export const cases: SkillCase[] = [
  {
    name: "flags a vendor SDK reached for directly from a service instead of behind an adapter",
    kind: "quality",
    prompt: `Review this code against our backend architecture rules.

\`\`\`ts
// server/src/modules/repos/service.ts
import { Octokit } from 'octokit';

export class RepoService {
  private octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  async listPulls(owner: string, repo: string) {
    return this.octokit.pulls.list({ owner, repo });
  }
}
\`\`\`

Is this okay to merge as-is?`,
    practices: [
      "identifies that service.ts (ring 3, application) is importing the octokit SDK directly, which belongs behind an adapter (ring 4)",
      "names the specific violated rule or its intent — no-vendor-sdks-outside-adapters / I/O SDKs must live in adapters/<capability>/",
      "recommends the fix as calling a port off the container (e.g. this.container.github.listPulls(...)) rather than constructing the Octokit client inline in the service",
      "does not suggest wrapping zod, graphology, p-queue or js-tiktoken the same way, since those are pure computation libraries and not adapters",
    ],
    threshold: 0.65,
    maxTurns: 8,
  },
  {
    name: "flags a service that takes a FastifyRequest instead of plain values",
    kind: "quality",
    prompt: `Review this code against our backend architecture rules.

\`\`\`ts
// server/src/modules/repos/service.ts
import type { FastifyRequest } from 'fastify';

export class RepoService {
  async add(req: FastifyRequest, url: string) {
    const workspaceId = await this.container.auth.currentWorkspace(req);
    return this.repo.insert(workspaceId, url);
  }
}
\`\`\`

Any concerns before this ships?`,
    practices: [
      "flags the FastifyRequest import/parameter in service.ts as a layering violation — services must not know about the transport layer",
      "names the specific violated rule or its intent — no-fastify-below-routes",
      "explains the consequence: a service that depends on FastifyRequest cannot be unit-tested without a full HTTP stack",
      "recommends the fix as resolving workspaceId in routes.ts (e.g. via getContext) and passing it into the service as a plain string parameter",
    ],
    threshold: 0.65,
    maxTurns: 8,
  },
  {
    name: "flags one module's service calling another module's service directly",
    kind: "quality",
    prompt: `Review this code against our backend architecture rules.

\`\`\`ts
// server/src/modules/repos/service.ts
import { ReviewService } from '../reviews/service.js';

export class RepoService {
  async add(workspaceId: string, url: string) {
    const repo = await this.repo.insert(workspaceId, url);
    await new ReviewService(this.container).run(repo.id);
    return repo;
  }
}
\`\`\`

Does this look right?`,
    practices: [
      "flags the cross-module import of another module's service.ts as a boundary violation",
      "names the specific violated rule or its intent — no-cross-module-internals / a module's service, repository and routes are private",
      "recommends the fix as enqueueing a job by kind (e.g. this.container.jobs.enqueue with a job-kind constant from reviews/constants.ts) instead of importing ReviewService directly",
      "does not suggest sharing the reviews module's service or repository through a direct import as an acceptable workaround",
    ],
    threshold: 0.65,
    maxTurns: 8,
  },
  {
    name: "flags a repository returning a Drizzle query builder and a query missing workspaceId scoping",
    kind: "quality",
    prompt: `Review this code against our backend architecture rules.

\`\`\`ts
// server/src/modules/repos/repository.ts
export class RepoRepository {
  constructor(private db: Db) {}

  listQuery() {
    return this.db.select().from(t.repos);
  }
}

// server/src/modules/repos/service.ts
const repos = await this.repo.listQuery().orderBy(desc(t.repos.createdAt)).limit(10);
\`\`\`

Anything wrong with this repository/service pair?`,
    practices: [
      "flags listQuery returning a Drizzle query builder to the caller instead of data, and identifies this as re-coupling the service to Drizzle (the IQueryable-leak pattern)",
      "flags that the query has no workspaceId scoping/parameter, calling this out as a tenancy bug",
      "recommends the fix as a method like list(workspaceId, { limit, order }) that takes the intent as parameters and returns rows or DTOs",
      "does not suggest fixing this by adding an ORM-level or unit-of-work abstraction",
    ],
    threshold: 0.65,
    maxTurns: 8,
  },
  {
    name: "flags a port interface whose signature leaks the vendor SDK's own types",
    kind: "quality",
    prompt: `We're adding a new port for GitHub access. Review this interface before we implement it.

\`\`\`ts
// server/src/vendor/shared/adapters.ts
import type { Octokit } from 'octokit';

export interface GitHubClient {
  octokit: Octokit;
  listPulls(o: Octokit.PullsListParams): Promise<Octokit.PullsListResponse>;
}
\`\`\`

Good to go?`,
    practices: [
      "identifies that the interface leaks Octokit's own types (Octokit, Octokit.PullsListParams, Octokit.PullsListResponse) into the port signature, so it is not actually a port",
      "states the underlying test: if replacing the vendor would force the interface to change, it is not an abstraction",
      "recommends redesigning the interface around domain-shaped parameters and return types with no reference to Octokit",
      "does not approve the interface as-is",
    ],
    threshold: 0.65,
    maxTurns: 8,
  },
  {
    name: "does not flag zod imports or a service resolving dependencies from the container as violations",
    kind: "quality",
    prompt: `Review this code against our backend architecture rules.

\`\`\`ts
// server/src/modules/repos/service.ts
import { z } from 'zod';

const AddRepoInput = z.object({ url: z.string().url() });

export class RepoService {
  private repo: RepoRepository;

  constructor(private container: Container) {
    this.repo = new RepoRepository(container.db);
  }

  async add(workspaceId: string, url: string) {
    const input = AddRepoInput.parse({ url });
    const existing = await this.repo.findByUrl(workspaceId, input.url);
    if (existing) return { repo: existing, created: false };
    const repo = await this.repo.insert(workspaceId, input.url);
    await this.container.jobs.enqueue('CLONE_REPO', { repoId: repo.id });
    return { repo, created: true };
  }
}
\`\`\`

Any architecture issues here?`,
    practices: [
      "does not flag the zod import as a layering violation, correctly treating zod as a pure computation library allowed in any ring",
      "does not flag constructing RepoRepository from container.db or using container.jobs.enqueue as a violation, since dependencies are being resolved from the container as intended",
      "the answer overall concludes this snippet does not violate the dependency rule (no fabricated violation is invented just to have something to report)",
    ],
    threshold: 0.6,
    maxTurns: 8,
  },
];
