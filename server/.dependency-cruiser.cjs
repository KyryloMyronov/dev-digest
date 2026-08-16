/**
 * Architecture lint — the Onion dependency rule, made executable.
 *
 * Run: `pnpm lint:arch`. The rules below are the machine-checkable half of
 * `.claude/skills/onion-architecture/SKILL.md`; that document is the "why".
 *
 * Ring order, outermost → innermost. Source dependencies may only point IN:
 *
 *   routes.ts                  presentation
 *   service.ts                 application
 *   repository*.ts, adapters/  infrastructure  (implements ports)
 *   vendor/shared/             ports + contracts
 *   reviewer-core/             domain core
 *
 * `platform/container.ts` is the composition root and is deliberately exempt
 * from most rules — it is the one place allowed to know every concretion.
 *
 * NOTE: dependency-cruiser is already a runtime dependency of this package
 * (`src/adapters/depgraph/` builds import graphs of *user* repos with it).
 * This config adds no new dependency.
 */

// Every module now layers routes → service → repository, so there is no legacy
// allow-list left and `no-db-schema-above-repository` runs at full severity.
// The last four to be refactored were pulls (381 lines), settings, polling and
// workspace — see .claude/skills/onion-architecture/SKILL.md §12.

module.exports = {
  forbidden: [
    // ---------------------------------------------------------------------
    // Infrastructure stays in the infrastructure ring
    // ---------------------------------------------------------------------
    {
      name: 'no-drizzle-outside-persistence',
      severity: 'error',
      comment:
        'drizzle-orm is persistence infrastructure. Only src/db/** and repository files ' +
        'may import it. A service or route that needs data asks a repository.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/db/',
          '^src/modules/[^/]+/repository\\.ts$',
          '^src/modules/[^/]+/repository/',
          '^src/platform/jobs\\.ts$', // job queue owns its own table
          '^src/adapters/auth/local\\.ts$', // auth adapter reads users/workspaces
          '^src/app\\.ts$', // stale-run reaping on boot
          '^src/modules/settings/feature-models\\.ts$',
        ],
      },
      to: { dependencyTypes: ['npm'], path: 'node_modules/drizzle-orm' },
    },
    {
      name: 'no-db-schema-above-repository',
      severity: 'error',
      comment:
        'Table definitions are infrastructure. Routes and services must not import ' +
        'src/db/schema — they work with DTOs produced by a repository.',
      from: {
        path: ['^src/modules/[^/]+/routes\\.ts$', '^src/modules/[^/]+/service\\.ts$'],
      },
      to: { path: '^src/db/schema' },
    },
    {
      name: 'no-vendor-sdks-outside-adapters',
      severity: 'error',
      comment:
        'Third-party SDKs live behind a port. Implement the interface in src/adapters/** ' +
        'and resolve it from the container; never import the SDK from a module.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/adapters/',
          '^src/platform/container\\.ts$', // composition root
          '^src/db/', // src/db IS the persistence adapter — it owns the driver
        ],
      },
      to: {
        dependencyTypes: ['npm'],
        // I/O and process-boundary libraries only. Pure computation libraries
        // (zod, graphology, p-queue) are not adapters — they may be imported
        // from any ring, same as a language built-in. See SKILL.md §4.
        path:
          'node_modules/(octokit|simple-git|@ast-grep/napi|openai|@anthropic-ai/sdk|' +
          'dependency-cruiser|@vscode/ripgrep|postgres)',
      },
    },

    // ---------------------------------------------------------------------
    // HTTP stays in the presentation ring
    // ---------------------------------------------------------------------
    {
      name: 'no-fastify-below-routes',
      severity: 'error',
      comment:
        'Fastify types are a transport detail. Services, repositories and adapters must ' +
        'be callable without an HTTP request — that is what makes them unit-testable.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/app\\.ts$',
          '^src/server\\.ts$',
          '^src/modules/index\\.ts$',
          '^src/modules/[^/]+/routes\\.ts$',
          '^src/modules/_shared/context\\.ts$',
          '^src/platform/(sse|container)\\.ts$',
        ],
      },
      to: { dependencyTypes: ['npm'], path: 'node_modules/(fastify|@fastify|fastify-)' },
    },

    // ---------------------------------------------------------------------
    // Module boundaries — slices talk through the container, not to each other
    // ---------------------------------------------------------------------
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        'A module\'s service, repository, routes and internals are private. Shared ' +
        'entities are exposed on the container (container.agentsRepo, ' +
        'container.reviewRepo, container.repoIntel); cross-module work is enqueued by ' +
        'job kind. A module\'s PUBLIC surface is its constants.ts (job kinds) and ' +
        'types.ts (facade interface) — importing those is allowed.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/_shared/',
          '^src/modules/$1/',
          '^src/modules/[^/]+/(constants|types)\\.ts$',
        ],
      },
    },
    {
      name: 'no-module-imports-from-platform',
      severity: 'error',
      comment:
        'platform/ is cross-cutting infrastructure and must not depend on a feature ' +
        'module. The one exception is container.ts, the composition root.',
      from: { path: '^src/platform/', pathNot: '^src/platform/container\\.ts$' },
      to: { path: '^src/modules/' },
    },

    // ---------------------------------------------------------------------
    // The core ring stays pure
    // ---------------------------------------------------------------------
    {
      name: 'no-server-imports-from-shared',
      severity: 'error',
      comment:
        'vendor/shared holds ports and contracts — the innermost server ring. It must ' +
        'not depend on anything that implements them.',
      from: { path: '^src/vendor/shared/' },
      to: { path: '^src/(modules|adapters|platform|db)/' },
    },
    {
      name: 'no-core-imports-from-server',
      severity: 'error',
      comment:
        'reviewer-core is the pure domain engine. It may depend on the ports and ' +
        'contracts in vendor/shared (that is the inward direction), but never on a ' +
        'module, adapter, platform service or the database.',
      from: { path: '^\\.\\./reviewer-core/' },
      to: { path: '^src/', pathNot: '^src/vendor/shared/' },
    },

    // ---------------------------------------------------------------------
    // Structural hygiene
    // ---------------------------------------------------------------------
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A runtime cycle means the ring boundary was crossed in both directions. ' +
        'Type-only cycles are excluded: a service importing `type { Container }` from ' +
        'the composition root that constructs it is the DI pattern, not a cycle — it ' +
        'erases at compile time.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code must not depend on a devDependency.',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|querystring)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|clones|drizzle)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
