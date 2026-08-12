# Skills

Reusable AI skills that provide specialized knowledge and workflows. Canonical location is `.claude/skills/` with a symlink at `.cursor/skills/ → ../.claude/skills` for Cursor compatibility. Shared with the team via version control.

## Catalog

| Skill | Scope | Description |
|-------|-------|-------------|
| [fastify-best-practices](fastify-best-practices/SKILL.md) | Backend | Fastify routes, plugins, JSON-schema validation, error handling |
| [drizzle-orm-patterns](drizzle-orm-patterns/SKILL.md) | Backend | Drizzle schema, queries, relations, transactions, migrations |
| [postgresql-table-design](postgresql-table-design/SKILL.md) | Backend | Postgres schema design, data types, indexing, constraints |
| [next-best-practices](next-best-practices/SKILL.md) | Frontend | Next.js App Router, RSC boundaries, data fetching, optimization |
| [react-best-practices](react-best-practices/SKILL.md) | Frontend | React anti-patterns, state management, hooks rules |
| [react-testing-library](react-testing-library/SKILL.md) | Frontend | General-purpose React Testing Library guide with Vitest |
| [zod](zod/SKILL.md) | Full-stack | Zod schema validation, parsing, error handling, type inference |
| [typescript-expert](typescript-expert/SKILL.md) | Full-stack | Type-level programming, performance, tooling, migrations |
| [security](security/SKILL.md) | Full-stack | OWASP Top 10:2025, auth, injection, uploads, secrets |
| [mermaid-diagram](mermaid-diagram/SKILL.md) | Shared | Mermaid diagrams in markdown (flowcharts, sequence, ERD, …) |
| [engineering-insights](engineering-insights/SKILL.md) | Shared | Recall and capture durable insights in each package's `insights.md` |
| [api-breaking-changes](api-breaking-changes/SKILL.md) | Full-stack | Detect wire-format breaks in a change — removed/renamed endpoints, weakened contracts, orphaned studio calls |
| [api-response-changes](api-response-changes/SKILL.md) | Full-stack | Detect response-payload breaks — fields removed or flipped optional/nullable, swapped response types, `.partial()` on a served contract |
| [response-schema](response-schema/SKILL.md) | Full-stack | Diff response payloads from the *consumer's* side — the studio's `api.get<T>()` generic as the declaration, with nested field paths and served/unserved severity |
| [source-scan](source-scan/SKILL.md) | Shared | **Library, nothing to run.** The one git-ref I/O + bracket-aware TS/JS scanner the three API skills are built on |

All skills above except `engineering-insights`, `api-breaking-changes`,
`api-response-changes`, `response-schema` and `source-scan` are vendored from
upstream and hash-locked by [`skills-lock.json`](../../skills-lock.json); local
edits to them get overwritten on sync. Those five are authored here and are not
locked.

### The three API skills

All three are worth running before a PR; they ask different questions.

| Skill | Question | Anchors on |
|---|---|---|
| `api-breaking-changes` | can a *caller* still reach the API? | endpoints, the module registry, request validation |
| `api-response-changes` | is the *server* sending a different payload? | the server side, in descending strength: route `response:` → handler annotation → service `Promise<…>` → inline literal (all 53 endpoints) |
| `response-schema` | does the payload still match what *consumers are typed against*? | the studio's `api.get<T>()` generic (47 bindings), plus route `response:` when one exists |

The last two overlap heavily and deliberately disagree about where the truth
lives. `api-response-changes` trusts the server and will catch a service return
type that drifts with no contract change. `response-schema` trusts the client
generic and will catch a payload that no longer matches the type consumers
compile against — including the case where the *generic itself* was always
wrong. Neither subsumes the other; run both before a PR that touches
`vendor/shared/`, and expect duplicate findings where they agree.

All three read TypeScript **without compiling it**, through one shared library:
[`source-scan`](source-scan/SKILL.md) (git-ref I/O + the bracket-aware scanner).
That scanner previously existed as two copies which drifted on whether `<`
belongs in the bracket-pairing table — a divergence that produced a silent wrong
answer and two entries in the root `insights.md`. Before changing a balanced
slice in any of the three, read that skill's **angle-bracket rule**, and verify
with the fixed invariants it lists (101 routes · 47 caller bindings · 53
endpoints) rather than by eyeballing a report.

## What Are Skills?

Skills are modular packages that extend the AI agent with specialized knowledge and workflows. Unlike rules (always applied) or agents (invoked for specific tasks), skills are loaded on-demand when the agent determines they're relevant.

### Skills vs Rules vs Commands vs Agents

| Type | Scope | Loaded | Purpose |
|------|-------|--------|---------|
| **Rules** (`.mdc`) | Project conventions | Always or by file pattern | Persistent guardrails |
| **Commands** (`.md`) | User actions | On `/command` invocation | Slash commands |
| **Skills** (`.md`) | Domain knowledge | On-demand by agent | Specialized knowledge |
| **Agents** (`.md`) | Workflows | Via Task tool | Subagent orchestration |

## Creating New Skills

Each skill has:

- `SKILL.md` — Main skill file with rules and conventions (required)
- `examples.md` — Code examples showing good/bad patterns (recommended)
- `references.md` — Sources and rationale (optional)
