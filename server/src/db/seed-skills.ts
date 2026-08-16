import { and, asc, eq } from 'drizzle-orm';
import type { SkillSource, SkillType } from '@devdigest/shared';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * Built-in skills used by the seed (L02).
 *
 * A skill is reusable review guidance: a directive `description` that states
 * when it applies, and a markdown `body` that is concatenated into the
 * `## Skills / rules` section of the prompt of every agent linking it. It is
 * TEXT — nothing here is executed, fetched, or resolved at run time.
 *
 * `description` is the skill's INTERFACE and is phrased as an instruction
 * ("Apply when…"), not as a summary. It is what an author reads in the library
 * to decide whether to attach the skill, and it is rendered into the prompt
 * ahead of the body so the model can decide whether the block applies to the
 * diff in front of it.
 *
 * NOTE the deliberate gap: `test-flake-signals`, the fourth Test Quality skill,
 * is NOT seeded. It ships as a markdown file in `docs/skills/` so the import
 * path (upload → preview → confirm) can be walked end to end against a skill
 * the workspace genuinely does not have yet. Seeding it would make the import
 * demo a no-op re-creation of an existing row.
 */

export interface SeedSkill {
  name: string;
  description: string;
  type: SkillType;
  source: SkillSource;
  body: string;
  /** Agents (by seeded name) that link this skill, in link order. */
  agents: string[];
}

export const SEED_SKILLS: SeedSkill[] = [
  {
    name: 'uncovered-branches',
    description:
      'Apply when the diff adds or changes a conditional, guard, early return, ' +
      'catch block, or default value. Report every branch that no test in the ' +
      'diff causes to execute.',
    type: 'rubric',
    source: 'manual',
    agents: ['Test Quality Reviewer'],
    body: `# Uncovered branches

For every conditional the diff adds or changes, enumerate its outcomes and
decide, for each one, whether some test in the diff makes it run.

## Method
1. List the branch points in the changed production code: \`if\` / \`else\`,
   ternaries, \`switch\` cases including the default, \`&&\` / \`||\` short-circuits
   that skip work, \`??\` fallbacks, optional chaining that can bail out, early
   returns, \`try\`/\`catch\`/\`finally\`, and loop bodies that can execute zero times.
2. For each outcome, name the test that reaches it. Reaching means the test's
   inputs and stubs actually drive execution into that branch — not that the
   test imports the file.
3. Report every outcome for which you cannot name such a test.

## What counts as a finding
State the branch, the input that would reach it, and the regression that would
go undetected. Cite the PRODUCTION line of the branch — that line is in the
diff; the test that was never written is not.

Do not report:
- branches in code the diff did not touch;
- the impossible arm of an exhaustive discriminated union;
- a branch reached by an existing test elsewhere in the same file, if you can
  see it in the diff context.

## Severity
- **CRITICAL** — the uncovered branch is the error, guard, or security path: the
  one that only runs when something has already gone wrong. These are the
  branches that are never exercised in production either, so a defect there
  surfaces for the first time during the incident it causes.
- **WARNING** — an uncovered ordinary branch, or an uncovered default case.
- **SUGGESTION** — an uncovered branch whose two arms are trivially equivalent.

## Worked example
A PR adds:

\`\`\`ts
export function summarize(items: Item[]) {
  if (items.length === 0) return { total: 0, average: null };
  return { total: sum(items), average: sum(items) / items.length };
}
\`\`\`

and one test passing three items. Finding: the \`items.length === 0\` early
return added at the \`if\` line is never executed — no test passes an empty
array, so a regression that returns \`average: 0\` instead of \`null\` (or divides
by zero) would ship green. WARNING.`,
  },
  {
    name: 'corner-cases',
    description:
      'Apply when the diff tests a function that takes collections, numbers, ' +
      'strings, dates, or optional values. Report the boundary and degenerate ' +
      'inputs the tests never pass.',
    type: 'rubric',
    source: 'manual',
    agents: ['Test Quality Reviewer'],
    body: `# Corner cases

A happy-path test proves the function works on the input the author had in mind.
Defects live at the edges of the input domain. For each parameter of the changed
code, work out its edges and check whether any test visits them.

## The edges, by type
- **Collections** — empty; exactly one element; duplicates; the boundary of a
  limit/page size and one past it; an element that is itself empty or null.
- **Numbers** — zero; negative; the exact threshold a comparison uses and the
  values either side of it; a non-integer where an integer is assumed; overflow
  of the range the caller can supply.
- **Strings** — empty; whitespace only; the length limit and one past it;
  characters outside ASCII; a value that also has meaning to the consumer
  (a path separator, a quote, a delimiter the code later splits on).
- **Optionals** — \`undefined\` and \`null\` treated as distinct, when the code
  distinguishes them; the field present but empty.
- **Time & order** — the two orderings of two events; the same timestamp twice;
  an interval of length zero.

## What counts as a finding
Name the parameter, the specific edge value, and what the code would do wrong
with it. An edge case is only worth reporting when the changed code would behave
differently there — an untested edge that provably takes the same path as a
tested one is not a gap.

Do not report an edge that the type system already excludes: if a parameter is
\`string[]\` and the language guarantees it is not null, "no test passes null" is
noise, not a finding.

## Severity
- **CRITICAL** — the edge produces a wrong result, a crash, or a bypassed check
  that the caller cannot detect.
- **WARNING** — the ordinary case: an untested edge with plausible wrong
  behaviour.
- **SUGGESTION** — an edge that is unreachable in practice given the current
  callers, but would become reachable if the function were reused.`,
  },
  {
    name: 'mocking-discipline',
    description:
      'Apply when a test file in the diff uses vi.mock, vi.fn, vi.spyOn, or a ' +
      'hand-written stub. Report mocks that replace the behaviour the test ' +
      'claims to verify.',
    type: 'convention',
    source: 'manual',
    agents: ['Test Quality Reviewer'],
    body: `# Mocking discipline

A mock is a claim that some collaborator's real behaviour does not matter to this
test. When the mock stands in for the thing under test, the test verifies the
mock and nothing else — and it stays green through any change to the real code.

## Report
- **The subject is mocked.** The module, class, or function the test names in its
  description is itself stubbed. This test cannot fail for any defect in that
  code.
- **The assertion is on the mock, not the outcome.** \`expect(spy).toHaveBeenCalledWith(...)\`
  where the meaningful result is the value returned to the caller or the row
  written to the database. Call-shape assertions pin the current wiring, so they
  break on every refactor and hold on every logic change — exactly backwards.
- **The stub cannot fail.** A mock that resolves successfully for every input
  means the error path it feeds is dead code in the test suite. If the real
  collaborator can reject, some test must make the stub reject.
- **The stub disagrees with the real contract.** A stubbed return shape that the
  real dependency never produces (a missing field, a bare value where the real
  one returns a wrapper, a resolved promise where the real one throws). The test
  passes against a dependency that does not exist.
- **Over-mocking a pure collaborator.** Mocking a function with no I/O adds a
  divergence risk and buys nothing — call it.

## In this repo specifically
- Adapters (\`src/adapters/**\`) exist to be swapped: injecting a fake through
  \`ContainerOverrides\` is the sanctioned pattern and is NOT over-mocking.
- Repositories in a \`*.it.test.ts\` should run against the real testcontainers
  Postgres. A mocked repository in an integration test defeats the reason that
  file pays for a container.

## Severity
- **CRITICAL** — the mock makes the test incapable of detecting the regression it
  exists to prevent, on a path that matters (money, auth, tenancy, data loss).
- **WARNING** — the ordinary case: a weaker test than it appears.
- **SUGGESTION** — an unnecessary mock that does not currently hide anything.

Do not report the mere presence of mocks, and do not ask for an integration test
where a unit test with an injected fake is the right tool.`,
  },
  {
    name: 'api-contract-gate',
    description:
      'Apply when the diff changes a route path, method, params/query/body ' +
      'schema, response shape, or status code. Report every change that breaks ' +
      'an existing caller.',
    type: 'convention',
    source: 'manual',
    agents: ['General Reviewer'],
    body: `# API contract gate

A route's request and response shapes are a contract with callers you cannot
see. Treat any narrowing of what is accepted, or any change to what is returned,
as breaking until the diff shows otherwise.

## Breaking, by construction
- **Request narrowed.** A field added as required; an existing optional field
  made required; an enum value removed; a looser type tightened
  (\`string\` → \`z.enum\`, \`number\` → \`z.number().int().positive()\`); a new
  \`.min()\` / \`.max()\` / \`.uuid()\` on a field callers already send.
- **Response narrowed or reshaped.** A field removed or renamed; a field that
  could be null now absent entirely; an array flattened to a single value or
  vice-versa; a value's type changed (id from number to uuid string).
- **Route identity changed.** Path renamed, a segment added, the method changed,
  a param moved between path / query / body.
- **Status codes changed.** A 200 that becomes 201 or 204; an error that moves
  between 4xx and 5xx; a previously-silent no-op that now 404s. Callers branch on
  these.
- **Defaults changed.** A default value, page size, sort order, or an omitted
  filter that now filters — same shape, different results.

## Not breaking
Adding an OPTIONAL request field; adding a field to a response; widening an
accepted type; adding a new route. Say so explicitly rather than reporting it.

## Method
1. Diff the schema, not the prose: compare the zod object before and after, field
   by field, including \`.optional()\` / \`.nullish()\` / \`.default()\`.
2. For each breaking change, name the caller that breaks and how it presents —
   a 422 on a request that worked yesterday, an \`undefined\` read downstream, a
   client whose generated type no longer matches the wire.
3. Check whether the diff carries the change through everywhere it must go. In
   this repo a wire type lives in \`server/src/vendor/shared/contracts/\` and is
   mirrored to \`client/src/vendor/shared/\`; a contract edited on one side only is
   a breaking change that will typecheck on both.

## Severity
- **CRITICAL** — an existing caller's working request now fails, or reads a field
  that is gone. Includes a contract changed on only one side of the mirror.
- **WARNING** — a change that is compatible today only because of an assumption
  about who calls it (an internal-only route, a field believed unused).
- **SUGGESTION** — a naming or shape improvement worth making while the route is
  already being changed.

Report the mechanism, never just "this is a breaking change".`,
  },
];

/**
 * Insert the built-in skills and link them to their agents.
 *
 * Idempotent in two independent ways, because they fail differently:
 *
 * - a **skill** is matched by `(workspace_id, name)` and skipped when present,
 *   so re-seeding never duplicates a row or resets a body the user has edited;
 * - a **link** is created only for a skill this run actually inserted. "Create
 *   the link whenever it is absent" reads like the safe rule and is the opposite:
 *   a link the user detached in the Skills tab is absent, so every re-seed would
 *   silently put it back. Keying off first insert makes seeding a bootstrap
 *   rather than a repair, so a detach survives `pnpm db:seed`.
 *
 * The trade-off, stated because it is not obvious: adding an agent to an
 * existing skill's `agents` list does NOT retro-link it, since that skill is no
 * longer newly created. Link it in the UI, or delete the row and re-seed.
 *
 * Body v1 is snapshotted into `skill_versions` in the same pass, matching what
 * `SkillsRepository.create` does — otherwise a seeded skill would have no
 * history until someone happened to edit it, and `/skills/:id/versions` would
 * be empty for exactly the skills the demo uses.
 *
 * A link whose agent does not exist is skipped rather than fatal: the agent seed
 * runs alongside this one, and a missing preset should not take down the whole
 * seed. `order` follows each skill's position in the agent's own list, which is
 * what decides the concatenation order of the prompt blocks.
 */
export async function seedSkills(db: Db, workspaceId: string): Promise<void> {
  // Agent name → the skills that name it, in SEED_SKILLS declaration order.
  const linksByAgent = new Map<string, string[]>();
  for (const s of SEED_SKILLS) {
    for (const agentName of s.agents) {
      const names = linksByAgent.get(agentName) ?? [];
      names.push(s.name);
      linksByAgent.set(agentName, names);
    }
  }

  const idByName = new Map<string, string>();
  /** Skills inserted by THIS run — the only ones that get linked. */
  const created = new Set<string>();

  for (const s of SEED_SKILLS) {
    const [existing] = await db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));

    if (existing) {
      idByName.set(s.name, existing.id);
      continue;
    }

    const [row] = await db
      .insert(t.skills)
      .values({
        workspaceId,
        name: s.name,
        description: s.description,
        type: s.type,
        source: s.source,
        body: s.body,
        enabled: true,
        version: 1,
      })
      .returning({ id: t.skills.id });

    idByName.set(s.name, row!.id);
    created.add(s.name);
    await db
      .insert(t.skillVersions)
      .values({ skillId: row!.id, version: 1, body: s.body })
      .onConflictDoNothing();
  }

  // Nothing new to link — every skill already existed, so leave every agent's
  // link set exactly as the user last arranged it.
  if (created.size === 0) return;

  for (const [agentName, skillNames] of linksByAgent) {
    const [agent] = await db
      .select({ id: t.agents.id })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, agentName)));
    if (!agent) continue;

    // Append after whatever the agent already links, so seeding a new skill does
    // not renumber the user's existing order.
    const current = await db
      .select({ skillId: t.agentSkills.skillId, order: t.agentSkills.order })
      .from(t.agentSkills)
      .where(eq(t.agentSkills.agentId, agent.id))
      .orderBy(asc(t.agentSkills.order));

    const linked = new Set(current.map((l) => l.skillId));
    let nextOrder = current.length;

    for (const name of skillNames) {
      if (!created.has(name)) continue;
      const skillId = idByName.get(name);
      if (!skillId || linked.has(skillId)) continue;
      await db
        .insert(t.agentSkills)
        .values({ agentId: agent.id, skillId, order: nextOrder++, enabled: true })
        .onConflictDoNothing();
      linked.add(skillId);
    }
  }
}
