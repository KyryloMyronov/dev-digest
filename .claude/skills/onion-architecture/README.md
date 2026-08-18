# Sources — `onion-architecture`

Every rule in [SKILL.md](SKILL.md) traces to one of these, or to a file in this
repo cited inline. Grouped by the decision each one informed.

## Foundational — the dependency rule

- [The Onion Architecture: part 1](https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/) — Jeffrey Palermo, 2008. The origin. Source of the meta-rule quoted in SKILL.md ("all code can depend on layers more central, but code cannot depend on layers further out"), the four tenets, and *"The database is not the center. It is external."* Also the tenet we lean on hardest: **inner layers define interfaces, outer layers implement them** — which is exactly what `vendor/shared/adapters.ts` is.
- [part 2](https://jeffreypalermo.com/2008/07/the-onion-architecture-part-2/) — a worked example (CodeCampServer).
- [part 3](https://jeffreypalermo.com/2008/08/the-onion-architecture-part-3/) — Onion contrasted with traditional layered architecture; why "the DB at the bottom" is the thing being rejected.
- [part 4 — After Four Years](http://jeffreypalermo.com/blog/onion-architecture-part-4-after-four-years/) — retrospective on what held up in practice.
- [Onion Architecture — Herberto Graça](https://medium.com/the-software-architecture-chronicles/onion-architecture-79529d127f85) — places Onion in the wider lineage (Hexagonal → Onion → Clean); the clearest single diagram of the ring model.
- [Chop Onions Instead of Layers — Methods & Tools](https://www.methodsandtools.com/archive/onionsoftwarearchitecture.php) — practical framing of why slicing beats stacking.

## Why Onion, and not Clean / Hexagonal / pure vertical slices

Informs **SKILL.md §13**.

- [Onion vs Clean vs Hexagonal — Eric Damtoft](https://medium.com/@edamtoft/onion-vs-clean-vs-hexagonal-architecture-9ad94a27da91) — the three are siblings, not rivals; differences are emphasis and vocabulary.
- [Clean vs Onion vs Hexagonal — CCD Akademie](https://ccd-akademie.de/en/clean-architecture-vs-onion-architecture-vs-hexagonal-architecture/) — maps the rings of each onto one another (Cockburn 2005 → Palermo 2008 → Martin 2012).
- [Demystifying software architecture patterns — Thoughtworks](https://www.thoughtworks.com/en-us/insights/blog/architecture/demystify-software-architecture-patterns) — vendor-neutral overview.
- [Where Vertical Slices Fit Inside the Modular Monolith — Milan Jovanović](https://milanjovanovic.tech/blog/where-vertical-slices-fit-inside-the-modular-monolith-architecture) — the source of our top-level shape: slices as the organizing principle, layers *inside* the slice. Directly justifies `modules/<name>/{routes,service,repository}`.
- [Architectures in Comparison: Onion or Vertical Slice? — CSA](https://www.csa.ch/en/blog/architectures-in-comparison-onion-or-vertical-slice) — when a shared domain layer earns its keep versus when slices should stay self-contained.
- [Layered vs Vertical Slice in Modular Monoliths — NILUS](https://www.nilus.be/blog/layered_architecture_vs_vertical_slice_in_modular_monoliths/) — "horizontal separation by technical concern vs vertical separation by business behaviour."

## Node.js / TypeScript implementation

- [Implementing SOLID and the Onion Architecture in Node.js with TypeScript — Remo Jansen](https://dev.to/remojansen/implementing-the-onion-architecture-in-nodejs-with-typescript-and-inversifyjs-10ad) — the canonical TS write-up. Its core claim shapes §2 and §5: *components depend on abstractions, not concretions,* and the application core carries no persistence or transport details.
- [Clean architecture with TypeScript: DDD, Onion — André Bazaglia](https://bazaglia.com/clean-architecture-with-typescript-ddd-onion/)
- [Melzar/onion-architecture-boilerplate](https://github.com/Melzar/onion-architecture-boilerplate) — a full Node/TS reference layout.
- [Achieve dependency inversion with Node.js, TypeScript and tsyringe](https://hofstede-matheus.medium.com/achieve-dependency-inversion-with-nodejs-typescript-and-tsyringe-8b956bc3254c) — makes the point we act on in §8: *you do not need a DI library to get dependency inversion.* A container is a pattern, not a package.

## Domain modelling — cited, deliberately not mandated

We stop at "onion-lite" (§13). These are the references for the day a module
earns real invariants.

- [Domain-Driven Design with TypeScript — Khalil Stemmler](https://khalilstemmler.com/articles/categories/domain-driven-design/) — entities, value objects, aggregate roots in TS.
- [DDD vs Clean Architecture — Stemmler](https://khalilstemmler.com/articles/software-design-architecture/domain-driven-design-vs-clean-architecture/) — which concepts overlap and which are distinct.
- [How to Design & Persist Aggregates — Stemmler](https://khalilstemmler.com/articles/typescript-domain-driven-design/aggregate-design-persistence/) — informs §6's "one repository per aggregate, not per table."

## Persistence, repositories, and their anti-patterns

Informs **SKILL.md §6**.

- [Designing the infrastructure persistence layer — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design) — repository interfaces belong to the domain, implementations to infrastructure; the cleanest statement of persistence ignorance.
- [Design Your Repository Like a Senior — anti-patterns](https://medium.com/clean-code-playbook/design-your-repository-like-a-senior-and-avoid-common-anti-patterns-9aacc2df3554) — source of two rules: **never return a query builder** (the `IQueryable` leak, which our "no query builder from a repository" example mirrors) and **no UI-centric sorting/pagination policy inside the repository**.
- [Anemic Domain Model — Wikipedia](https://en.wikipedia.org/wiki/Anemic_domain_model) — the failure mode of scattering rules into repositories and services. Acknowledged honestly in §13: this codebase *is* service-oriented, and we chose that over speculative aggregates.
- [Repository Pattern — DevIQ](https://deviq.com/design-patterns/repository-pattern/) — includes the warning that a repository returning Active Record objects leaks persistence all the way into views.
- [The Repository Pattern — Klaviyo Engineering](https://klaviyo.tech/the-repository-pattern-e321a9929f82) — a production account of repository granularity.
- [Drizzle ORM Best Practices — Paul Șerban](https://paulserban.eu/blog/post/drizzle-orm-best-practices-principles-patterns-and-real-world-case-studies/) — source of "API types, business logic types and database row types should be distinct," which §6 turns into the row → DTO rule.
- [Repository Pattern with Drizzle ORM](https://medium.com/@vimulatus/repository-pattern-in-nest-js-with-drizzle-orm-e848aa75ecae)
- [Drizzle: unit-of-work feature request #2543](https://github.com/drizzle-team/drizzle-orm/issues/2543) — why §6 says use `db.transaction` inside the repository instead of hand-rolling a Unit of Work: Drizzle has no first-class one, and a homemade one leaks the ORM upward.
- [Transactions with DDD and the Repository Pattern in TypeScript](https://medium.com/@joaojbs199/transactions-with-ddd-and-repository-pattern-in-typescript-a-guide-to-good-implementation-part-2-da0af3e10901)

## Fastify and dependency injection

Informs **SKILL.md §8** — specifically the decision *not* to add a DI library.

- [fastify/fastify-awilix](https://github.com/fastify/fastify-awilix) and [@fastify/awilix on npm](https://www.npmjs.com/package/@fastify/awilix) — the standard Fastify DI option, evaluated and declined.
- [Fastify issue #2587 — Plugin for Dependency Injection](https://github.com/fastify/fastify/issues/2587) — the maintainers' discussion; Fastify's plugin encapsulation plus decorators already provides most of what a DI container gives.
- [lumitech-node-fastify-template](https://github.com/lumitech-co/lumitech-node-fastify-template) — Fastify + Awilix + clean architecture reference, useful as a contrast to our hand-rolled `Container`.

## Enforcing the architecture

Informs **SKILL.md §11** and `server/.dependency-cruiser.cjs`.

- [dependency-cruiser — sverweij](https://github.com/sverweij/dependency-cruiser) — the tool we use. Already a dependency of `server/` for a different purpose (`adapters/depgraph/` cruises *user* repos), so architectural linting cost us no install.
- [eslint-plugin-boundaries — javierbrea](https://github.com/javierbrea/eslint-plugin-boundaries) — the main alternative. Declined only because this repo has no ESLint setup at all; if one is ever added, this is the more ergonomic layer-rule tool.
- [Architectural Linting — Steve Kinney](https://stevekinney.com/courses/enterprise-ui/architectural-linting-exercise) — the case for turning architectural intent into checks that run on every commit rather than review comments.
- [Three Ways to Enforce Module Boundaries — Stefanos Lignos](https://www.stefanos-lignos.dev/posts/nx-module-boundaries) — comparison of boundary-enforcement strategies.
- [dependency-cruiser rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) — the `viaOnly` / `dependencyTypesNot` semantics that let `no-circular` ignore type-only DI edges.
