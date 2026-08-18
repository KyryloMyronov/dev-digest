# Skills — reusable review guidance, attached per agent

**Status:** shipped
**Lesson:** L02

Spec lives in `server/specs/` because the module, the link semantics and the
prompt-assembly decision are the load-bearing part; the two UI surfaces are
described in **Screens** below and are implemented in `client/`.

## Problem

Every review criterion an agent applies lives inside its `system_prompt`. That
makes a criterion unshareable (two reviewers that want the same "no uncovered
branches" rule each carry their own copy of the paragraph, and the copies
drift), un-toggleable (turning one rule off means editing the prompt and
remembering what it said), and invisible in the trace (one opaque system
message, no way to see which rule produced which finding). There is also no way
to bring in guidance written elsewhere: a markdown skill from another tool has
to be pasted into a prompt by hand.

Most of the plumbing already existed and was unused. `skills`,
`skill_versions` and `agent_skills` are in the schema with no module behind
them; `Skill` / `AgentSkillLink` are already in `@devdigest/shared`;
`reviewer-core`'s `PromptParts.skills` is already assembled into a
`## Skills / rules` section (`prompt.ts:109`) and recorded as
`PromptAssembly.skills`, which the Run Trace drawer already renders
(`TraceBody.tsx:76`). What was missing was everything in between — no CRUD, no
link management, and a `run-executor` that never passed a `skills` array.

## Scope

- A **skills module** (`src/modules/skills/`): CRUD over the library, plus
  `/skills/:id/versions` (body history) and `/skills/:id/agents` (who links it).
- **Link endpoints on the agents module**: `GET/POST /agents/:id/skills`,
  `PATCH/DELETE /agents/:id/skills/:skillId`. The agents module owns the agent
  side of `agent_skills`; the skills module never writes it.
- `agent_skills.enabled` — a **per-agent** switch that is separate from the link
  itself and from the skill's own global `skills.enabled`.
- `run-executor` resolves an agent's linked skills into ordered prompt blocks
  and passes them to `reviewPullRequest`.
- `src/modules/_shared/skills.ts` — `toSkillDto` + `skillPromptBlock`, shared
  because three modules read a skill row.
- Client: the `/skills` library (grid · preview · editor · import) and the agent
  editor's **Skills** tab.
- Import of a `.md` / `.zip`, parsed **in the browser** and saved through the
  ordinary `POST /skills`.
- Seed: four skills, three linked to *Test Quality Reviewer* and one to
  *General Reviewer*; a fourth Test-Quality skill ships **unseeded** as a file.

## Out of scope

- **The conventions extractor**, the other half of L02's roadmap row. `source:
  'extracted'` and `evidence_files` exist for it and stay unpopulated —
  `toSkillDto` carries `evidence_files` through, nothing ever sets it.
- **A server-side import endpoint, and any fetching.** Deliberate, not
  deferred — see *Import* below. A URL inside a skill body is text.
- **Executing anything.** A skill is text; nothing in this pipeline runs,
  evaluates or resolves anything out of a body. Non-markdown archive members are
  listed and dropped client-side and never reach the API.
- **A version-history screen or rollback.** `GET /skills/:id/versions` and the
  `useSkillVersions` hook exist and are unused by any component. The snapshots
  are written now so the history is already there when a screen wants it;
  writing them later would start the record at "whenever we got round to it".
- **Community skills.** `CommunitySkill` is declared, and `'community'` is
  honoured everywhere downstream — the prompt labeller treats it as foreign, the
  library badges it, the message catalogue names it, and `POST /skills` would
  accept it. There is simply no screen that browses or installs one.
- **Eval of a skill.** `EvalOwnerKind` already includes `'skill'`; that is L06.
- **Plugin export/import of skills** (`PluginSkill` in `productionize.ts`) — L08.
- **Token budgeting or de-duplication across skills.** Every enabled block goes
  in, in link order, whole. An agent with twenty long skills will blow its
  context, and nothing warns.
- **Workspace-scoping the *skill* on link.** See *Open questions*.

## Two switches, and why they are separate

`agent_skills` carries both `order` and `enabled`, and a skill reaches a prompt
only when **both** of these are true:

| Switch | Column | Meaning |
|---|---|---|
| the link | `agent_skills.enabled` | this agent uses this skill |
| the skill | `skills.enabled` | this skill is usable at all, by anyone |

Disabling a **link** keeps the attachment and its position: the row stays in the
Skills tab, unchecked, in place. That is the whole point — the with/without
comparison is one click and one click back, and the skill returns to the same
slot in the concatenation, so the only thing that changed between the two runs
is the presence of that block. Unlinking would lose the order and make the
second half of the comparison a different experiment.

Disabling the **skill** switches it off for every agent at once, which is what
you want when a rule turns out to be noisy and you don't want to hunt down five
agents. `SkillsTab` marks such a link with a *globally disabled* badge rather
than silently rendering a checked box that does nothing.

Both filters live in one place — `buildSkillBlocks` in `run-executor.ts:349`:

```ts
const active = links.filter((l) => l.enabled && l.skill.enabled);
const skipped = links.filter((l) => !(l.enabled && l.skill.enabled));
```

Skipped skills are **logged by name** to the run log. A block that is missing
because the user switched it off and a block that is missing because the feature
is broken look identical in the assembled prompt; the log line is the only thing
that distinguishes them. For the same reason `buildSkillBlocks` never throws: a
failed lookup degrades to an unskilled review and says so in the log, because
failing the whole run over the guidance layer is worse than reviewing without it.

When no skill is active the `skills` key is **omitted** from the
`reviewPullRequest` call (`run-executor.ts:215`), so `assemblePrompt` produces a
user message byte-identical to the pre-skills baseline. That equality is what
the control experiment measures against.

## The prompt block, and why it is NOT wrapped in `<untrusted>`

`skillPromptBlock()` (`src/modules/_shared/skills.ts`) renders one block:

```
### Skill: uncovered-branches (rubric · v3 · source: imported)
Apply when the diff adds or changes a conditional… Report every branch that…

# Uncovered branches
…body…
```

The heading carries the name, the type, the version and — for `imported_url` /
`community` — a literal `source: imported` marker. The description sits above
the body because it is the skill's *interface*: it says directively when the
skill applies, which is what lets the model decide whether the block is relevant
to the diff in front of it.

The body goes in **as instructions, undelimited**. This is the single decision
in the feature most likely to be "fixed" by someone reading the diff, so:
wrapping a skill in `wrapUntrusted()` — the treatment the diff and the PR
description get — hands it to `INJECTION_GUARD` (`reviewer-core/src/prompt.ts`),
which tells the model that everything inside `<untrusted>…</untrusted>` is DATA
and never instructions, in any language. A skill *is* instructions. The guard
and the wrapper cancel out, and the result is a skill that is attached, visible
in the trace, counted in the tokens, and completely inert. Nothing errors. Full
write-up: the root [`insights.md`](../../insights.md) entry dated 2026-08-08,
"a product skill must NOT be wrapped in `<untrusted>`, and that is the point".

Containment is therefore replaced by **provenance and consent**:

- the block is labelled — name, type, version, and `source: imported` when the
  text came from outside the workspace;
- the same fact is badged in the library and carries a trust notice in the
  preview panel;
- an import is shown in full and written only on confirmation (below);
- nothing executes, so the blast radius of a hostile skill is "the review says
  something wrong", not "the review does something".

`server/test/skills-helpers.test.ts` pins the absence of the wrapper explicitly
("does NOT wrap the body in `<untrusted>` — a skill is instructions") so the
hardening cannot be reintroduced as a silent feature kill. Reader-facing
rationale: [`docs/skills/README.md`](../../docs/skills/README.md) and
[`docs/agent-prompts/README.md`](../../docs/agent-prompts/README.md).

## Import — parsed in the browser, saved as an ordinary create

There is **no import endpoint**. `client/src/lib/skill-import.ts` reads the file
locally, `ImportSkillModal` previews it, the user accepts, the parsed fields are
handed to the normal skill editor, and the save is a plain
`POST /skills` with `source: "imported_url"`.

Consequences, all of them intended:

- **Nothing is uploaded before confirmation.** An archive's scripts, manifests
  and binaries never leave the machine. If the parse is rejected, the API never
  saw the file at all.
- **Only markdown is read.** `parseSkillArchive` takes entries whose contents
  sit behind a lazy `text()` and calls it exactly once — on the core markdown
  (`SKILL.md`, else the shallowest `.md`, ties broken alphabetically so a given
  archive always yields the same skill). Every other member is recorded **by
  path** and never opened. Executable-looking paths are counted separately and
  called out in the preview.
- **Frontmatter is read by a flat `key: value` reader**, not a YAML engine — the
  metadata is three scalars, and pulling in a parser to run over untrusted input
  to read three strings is a worse trade. Anything it cannot understand stays in
  the body, where it is harmless.
- **Missing metadata warns instead of rejecting.** A skill written for another
  tool imports: `name` falls back to the first heading, then the filename;
  `type` falls back to `custom`; a missing `description` is a warning, because
  the description is the interface and a skill without one is worth fixing in
  the form rather than after the fact.
- Files are read through `FileReader`, not `Blob.text()` — jsdom 25 implements
  neither of the modern methods, which would make the whole path untestable
  (client [`insights.md`](../../client/insights.md), 2026-08-08).

`source` is never inferred server-side: `SkillsService.create` defaults it to
`manual`, so a caller cannot accidentally launder an import into a local skill,
and the import flow states its real origin explicitly.

## Versioning — the body, and only the body

`skills.version` starts at 1 and the creating insert snapshots body v1 into
`skill_versions` in the same call. On update, `isBodyChange`
(`modules/skills/helpers.ts`) is true only when the patch carries a body
*different* from the stored one; then and only then `version` is bumped and the
**new** body is snapshotted (`modules/skills/repository.ts`). Renames, retypes,
description edits and enable/disable leave the version alone, and re-saving an
unchanged body does not manufacture a version.

This is deliberately narrower than the agents module's `isConfigChange`: the
prompt only ever sees `body` (plus the name/type/version header this module
renders), so versioning a rename would fill the history with entries no run
could ever differ on. The snapshot insert is `onConflictDoNothing` and
`(skill_id, version)` is the table's primary key, so a retry cannot duplicate or
rewrite a recorded body.

## The control experiment — why *Test Quality Reviewer* is thin

The seeded *Test Quality Reviewer* prompt
([`docs/agent-prompts/test-quality-reviewer.md`](../../docs/agent-prompts/test-quality-reviewer.md),
mirrored in `db/seed-prompts.ts`) carries role, method and the output
conventions — and deliberately **not** its review rubrics. Uncovered branches,
corner cases, mocking discipline and flake signals are the *skills*. The prompt
says so, and tells the model to apply `## Skills / rules` when present and to
invent no equivalents when absent.

That split is the only reason the feature is demonstrable. Run the agent on a PR
whose test covers the happy path only:

- **skills off** → no `## Skills / rules` section; the agent approves, because
  "a test exists and passes" is all the prompt asked for;
- **skills on** → the same model on the same diff flags the uncovered branch and
  the missing boundary case.

Thicken the system prompt with the rubrics and that comparison stops
demonstrating anything — the agent finds the branch either way, and the only
thing the toggle changes is the token count. New review criteria go in skills.
This is a property of the seed data, so it is worth restating in review: a
"helpful" PR that moves a skill's content into the system prompt silently
destroys the experiment while every test still passes.

The gap in the seed is deliberate too: `test-flake-signals` is **not** seeded and
ships as [`docs/skills/test-flake-signals.md`](../../docs/skills/test-flake-signals.md)
so the import path can be walked end to end against a skill the workspace
genuinely does not have. Seeding it would make the import demo a no-op.

## Screens

### 1. `/skills` — the library

Nav: **SKILLS LAB → Skills** (`g s`). A grid of cards, one per skill: name,
description, type chip, `v{n}`, an `imported` badge for foreign sources, and a
toggle that writes `skills.enabled` straight from the card (its click is stopped
from also opening the preview). Search filters name, description and type
client-side.

Clicking a card opens a **preview panel** beside the grid — read-only, showing
the exact text that goes into a prompt: badges (type · source · `v{n}` ·
disabled), the imported trust notice, the description, **who links it**
(`GET /skills/:id/agents`, so a delete warns by name), and the body rendered as
markdown. The panel is an `<aside>` with an `aria-label`, because the app
shell's sidebar is already an unnamed `complementary` landmark.

Selection is resolved against the live list rather than held as an object, so an
edit or a toggle updates the open panel instead of showing stale text.

**Add** is a two-item menu: *Create from scratch* → the editor modal, or
*Import from file…* → the import modal, which on accept hands a pre-filled draft
to **the same editor**. An imported skill is reviewed and corrected in exactly
the fields a hand-written one is, and is saved by the same button.

States: skeleton grid while loading · `ErrorState` with retry · `EmptyState`
with a create CTA · populated grid.

Hooks: `lib/hooks/skills.ts` — `useSkills`, `useSkill`, `useSkillAgents`,
`useCreateSkill`, `useUpdateSkill`, `useDeleteSkill`. A body edit or a delete
invalidates `agentKeys.all` as well, because every agent link now renders a
different block (or none).

### 2. Agent editor → **Skills** tab

`/agents/:id?tab=skills`. Three actions kept distinct on purpose:

- **attach** — a workspace skill becomes this agent's (a row in `agent_skills`);
- **enable** — the per-agent checkbox; unchecking keeps the row and its position;
- **reorder** — up/down arrows set the concatenation order.

Reordering is arrow buttons rather than drag-and-drop: no dependency, works from
the keyboard, and testable without synthesising pointer events. The arrows are
genuinely `disabled` at the ends, not merely dimmed.

A reorder sends the **whole** ordered set with each link's `enabled` carried
through (`toLinkPayload`) — dropping the flag would let the server's
"attach enabled by default" silently re-enable every disabled skill on a drag.
A toggle uses `PATCH`, which touches one link and leaves the order alone.

Unattached skills are offered as *Available* buttons; attaching appends to the
end. A linked skill that is globally disabled gets a badge. The header counts
enabled-of-linked, which is the number that predicts the prompt.

Every link mutation returns the agent's full re-ordered link list and the hook
seeds the cache from the response rather than invalidating — a reorder that
refetched would flash the old order between the click and the response.

### 3. Run trace drawer — nothing new

`TraceBody` already renders `prompt_assembly.skills` as its own coloured block
when non-null. This feature simply makes it non-null. It is the evidence
surface: the exact concatenated text the model received, next to the run log
lines naming which skills were attached and which were skipped.

Note for later: `AgentCard` accepts a `skillCount` prop and renders it, but
`AgentsListView` does not pass one, so the agents list shows no count today.

## Contract changes

`@devdigest/shared` — canonical at `server/src/vendor/shared/`, **mirrored by
hand** into `client/src/vendor/shared/`; `./scripts/check-contracts.sh` enforces
it. `contracts/knowledge.ts` on both sides:

- `+ SkillVersion` — `{ skill_id, version, body, created_at }`, `created_at` an
  ISO string (the wire never carries a `Date`).
- `AgentSkillLink` `+ enabled: z.boolean()`.
- `+ AgentSkillDetail = AgentSkillLink.extend({ skill: Skill })` — what
  `GET /agents/:id/skills` serves, so the Skills tab renders names, types and
  bodies without an N+1 over `/skills/:id`.

`Skill`, `SkillType`, `SkillSource`, `CommunitySkill`, `PromptAssembly.skills`
and `PromptParts.skills` were already declared and are unchanged.

### Routes

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/skills` | — | `Skill[]`, workspace-scoped, by name |
| GET | `/skills/:id` | uuid | `Skill` · 404 |
| POST | `/skills` | `{name, description, type?, source?, body, enabled?}` | `Skill`, **201** |
| PUT | `/skills/:id` | `name` · `description` · `type` · `body` · `enabled`, all optional; **no `source`** | `Skill` · 404 |
| DELETE | `/skills/:id` | uuid | `{ok:true}` · 404 |
| GET | `/skills/:id/versions` | uuid | `SkillVersion[]`, newest first · 404 |
| GET | `/skills/:id/agents` | uuid | `string[]` agent names, A→Z · 404 |
| GET | `/agents/:id/skills` | uuid | `AgentSkillDetail[]`, by order · 404 |
| POST | `/agents/:id/skills` | `{links[]}` \| `{skill_ids[]}` \| `{skill_id, order?}` | full `AgentSkillDetail[]` · 404 |
| PATCH | `/agents/:id/skills/:skillId` | `{enabled}` | full list · 404 |
| DELETE | `/agents/:id/skills/:skillId` | — | full list · 404 |

`POST /agents/:id/skills` has three forms and refuses a body with none of them:
`links` (the rich form — order **and** `enabled` per entry, so a reorder and a
toggle are one save), `skill_ids` (order-only shorthand, everything enabled), and
`skill_id` (link one, appended unless `order` is given). Every mutation returns
the agent's whole link list, so the client never reassembles it.

`:id` is validated as a uuid at the edge (`IdParams`), so a malformed id is a
clean 422 rather than a 404 or a downstream 500. A `PATCH` of a link the agent
does not have is 404, and so is a foreign-workspace agent — deliberately
indistinguishable across tenants.

## Schema changes

All three tables already existed. One column added:

- `agent_skills.enabled boolean NOT NULL DEFAULT true` — generated via
  `pnpm db:generate`; the `ALTER TABLE` landed in `0011_red_dagger.sql`
  (batched with the conventions columns from the same generate run).
  `DEFAULT true` is what makes the migration safe on existing rows: every link
  that existed before this feature meant "in the prompt", and that is what it
  keeps meaning.

`skills` is a tenant root and carries `workspace_id`. `skill_versions` and
`agent_skills` do not: they reach their workspace through
`skill_id → skills.workspace_id` / `agent_id → agents.workspace_id`, with
`onDelete: 'cascade'` — which is why `linkedAgentNames` must join through
`agents` to scope, and why a test exists for exactly that join.

**Seed** — `seedSkills(db, workspaceId)` in `db/seed-skills.ts`, called from
`seed.ts` **after** the agent presets, since links resolve by agent name:
`uncovered-branches`, `corner-cases`, `mocking-discipline` → *Test Quality
Reviewer*, in that link order; `api-contract-gate` → *General Reviewer*. Body v1
is snapshotted into `skill_versions` in the same pass, so a seeded skill has a
history without waiting for someone to edit it.

A skill is matched by `(workspace_id, name)` and skipped when present. A **link**
is created only for a skill that run actually *inserted* — not merely "when the
link is absent", which is the rule that reads safe and is the opposite: a link
the user detached in the Skills tab is absent, so every `pnpm db:seed` would put
it back. Verified both ways against a throwaway database: from zero the three
links appear in order, and after a detach two further re-seeds leave it detached
and leave a disabled link disabled. The trade-off is that adding an agent to an
existing skill's `agents` list does not retro-link it.

The *Test Quality Reviewer* agent itself is a seeded preset
(`TEST_QUALITY_REVIEWER_PROMPT` in `db/seed-prompts.ts`, mirroring
[`docs/agent-prompts/test-quality-reviewer.md`](../../docs/agent-prompts/test-quality-reviewer.md)).

**Control-experiment fixtures — declared, NOT seeded.** `db/seed-fixtures.ts`
exports `CONTROL_EXPERIMENT_PRS` (PRs **#486** and **#489**: #486 plants an
uncovered branch and an untested boundary for *Test Quality Reviewer* +
`uncovered-branches` / `corner-cases`; #489 makes an optional request field
required for *General Reviewer* + `api-contract-gate`) and **nothing imports it**
— there is no `seedFixtures` function and `seed.ts` never calls one. The manual
quality comparison therefore has to be run against a PR you pick yourself until
that is wired. Walkthrough:
[`docs/skills/control-experiment.md`](../../docs/skills/control-experiment.md).

## Server work

**`src/modules/skills/`** — the standard route → service → repository stack.
`repository.ts` owns `skills` + `skill_versions` and never writes `agent_skills`.
`listVersions` / `linkedAgentNames` gate on a workspace-scoped parent lookup
first and return `undefined` for an unknown-or-foreign id, so the route 404s
instead of leaking whether the id exists in another tenant.

**`src/modules/_shared/skills.ts`** — `toSkillDto` and `skillPromptBlock`. The
mapper lives here rather than in `modules/skills/helpers.ts` because `agents`
(inlining a skill into a link) and `reviews` (rendering a prompt block) both
need it, and `no-cross-module-internals` allows only `constants.ts` / `types.ts`
/ `_shared/` across a module boundary. `modules/skills/helpers.ts` re-exports
`toSkillDto` so its own call sites read normally. See server
[`insights.md`](../insights.md), 2026-08-08.

**`src/modules/agents/`** — the link table's agent side. `setSkills` is
delete-then-insert **in one transaction**: the intermediate state is an agent
with no skills at all, and a review that started between the two statements
would assemble a prompt with the skills block missing entirely — a silently
wrong run rather than a failed one.

**`src/modules/reviews/run-executor.ts`** — `buildSkillBlocks` (above), the
`...(skills.length > 0 ? { skills } : {})` spread, and nothing else. The engine
call already accepted `skills`.

## Client work

New:

- `src/lib/skill-import.ts` + `.test.ts` — the parser. In `lib/` and not beside
  the modal because it is pure and independently testable, which is the whole
  argument for parsing in the browser.
- `src/lib/hooks/skills.ts` — library hooks and link hooks in one file, keyed
  through `hooks/keys.ts` (`skillKeys`, `agentKeys.skills`).
- `src/app/skills/` — `page.tsx` (thin) + `_components/SkillsListView/` with
  `SkillCard`, `SkillPreview`, `SkillEditorModal`, `ImportSkillModal`, plus
  colocated `styles.ts` / `constants.ts` / `helpers.ts`.
- `src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/`.
- `messages/en/skills.json`; `agents.json` gains the `skills.*` block.

Edited: `AgentEditor.tsx` + `constants.ts` (a second tab, and `TAB_KEYS` so
`?tab=` falls back instead of rendering blank), `vendor/ui/nav.ts` (the
**Skills** entry and its `g s` shortcut), `client/README.md` (route map).

`jszip` is imported dynamically inside `readSkillFile`, so the ~100 kB unzip
library is only fetched by someone who actually imports an archive.

## Acceptance criteria

Checked = covered by an automated test, named beside it.

- [x] A create lands at `version` 1, snapshots body v1, and defaults `source` to
      `manual` unless the caller declares one. — `skills.it.test.ts`
- [x] A body edit bumps `version` and keeps the previous body retrievable at
      `/skills/:id/versions`; a metadata-only edit and a re-save of an unchanged
      body create no version. — `skills-helpers.test.ts` (`isBodyChange`) +
      `skills.it.test.ts` (three cases)
- [x] Attaching sets `order` = index and `enabled` = true; `PATCH` flips one
      link without disturbing the order; a reorder carrying `enabled: false`
      keeps that link disabled. — `skills.it.test.ts` +
      `SkillsTab.test.tsx` ("reordering PRESERVES each link's enabled flag")
- [x] Deleting a skill cascades its links and its version history, the agents
      survive, and `/skills/:id/agents` names them beforehand. —
      `skills.it.test.ts`
- [x] Every read and write is workspace-scoped, and `linkedAgentNames` does not
      leak an agent from another workspace. — `skills.it.test.ts`
- [x] An unknown id 404s on every read and write; a non-uuid id 422s at the
      edge. — `skills.it.test.ts`
- [x] A link that is enabled on a skill that is enabled produces its own
      labelled block in the persisted trace's `prompt_assembly.skills`, and the
      run log names it. — `skills-prompt.it.test.ts`
- [x] A link disabled **for the agent** produces no skills block at all; a skill
      disabled **in the library** is skipped even when its link is enabled. —
      `skills-prompt.it.test.ts` (two cases)
- [x] Blocks are concatenated in link order, and reordering changes the
      assembled prompt. — `skills-prompt.it.test.ts`
- [x] An agent with no skills produces no `## Skills / rules` section — the
      baseline the comparison is against. — `skills-prompt.it.test.ts`
- [x] An imported skill's block carries `source: imported`. —
      `skills-prompt.it.test.ts` + `skills-helpers.test.ts`
- [x] The body is **not** wrapped in `<untrusted>`. —
      `skills-helpers.test.ts`
- [x] Import reads only the core markdown — no other archive member is opened —
      lists dropped members, flags executables, prefers `SKILL.md`, falls back
      for a missing name/type with warnings, and rejects an archive with no
      markdown. — `skill-import.test.ts`
- [x] Import previews the file and saves nothing until the editor is confirmed.
      — `SkillsListView.test.tsx`
- [x] The library renders a card per skill with its type, badges an imported
      one, filters by name, opens a preview beside the grid, and creates and
      edits a skill. — `SkillsListView.test.tsx`
- [x] The Skills tab lists attached skills in order with an enabled count, keeps
      a disabled link attached and in place, disables the arrows at the ends,
      offers only unattached skills, marks a globally-disabled skill, and
      returns a detached skill to the attachable list. — `SkillsTab.test.tsx`
- [ ] **Manual only — the quality comparison.** *Test Quality Reviewer* on a
      happy-path-only test PR approves with its skills disabled and reports the
      uncovered branch / missing boundary case with them enabled. The automated
      suites run against `MockLLMProvider`, so they can assert only what was
      **sent** to the model, never what a model concluded from it. Everything
      above the model is pinned; the last step is an experiment, run by hand.
      The fixtures for it are seeded (PRs **#486** and **#489**,
      `db/seed-fixtures.ts`) and the walkthrough for both agents is
      [`docs/skills/control-experiment.md`](../../docs/skills/control-experiment.md).
- [x] Both skills screens read the **real** API across a process boundary — the
      one class of risk the RTL suites structurally cannot cover, since they stub
      `fetch` and so cannot see a wrong shape from `GET /skills/:id/agents` or
      from `GET /agents/:id/skills` (which inlines the skill row). —
      `e2e/specs/09-skills.flow.json`, read-only against the seed. Running it
      needs the `agent-browser` CLI installed once
      (`npm i -g agent-browser && agent-browser install`); without it every flow
      in the suite fails at spawn, not just this one.

## Open questions

Two judgement calls, recorded here rather than re-litigated later, and one real
gap:

- **A linked skill is not checked against the agent's workspace.**
  `setSkills` / `linkSkill` scope the **agent** by workspace and then trust the
  `skill_id`s, so a caller that knows a uuid from another tenant can link it;
  the FK is the only check. Not reachable from the UI (the picker only lists
  this workspace's skills) and not a read leak in the other direction —
  `linkedAgentNames` does join through `agents`. Fixing it is one scoped
  `inArray` lookup in `AgentsService.setSkills` plus a 422; it is unfixed
  because the module boundary makes the natural place to ask
  (`skillsRepo.list`) a cross-module read that does not exist yet.
- **Order is per link, not per skill.** Two agents can concatenate the same
  three skills in different orders. Intended: order is an agent's composition
  decision.
- **A run records which skills it used only in the trace text.**
  `agent_versions.config.skills` snapshots the linked ids, but only when the
  *agent's own config* changes (`AgentsRepository.snapshotVersion`) — attaching,
  reordering, toggling or editing a skill creates no agent version at all. So
  two runs of the same agent version can have used different skill text, and the
  only per-run record of what was actually sent is the assembled prompt stored
  in the run trace. Good enough while traces are retained; an eval that replays
  a past run (L06) will need the skill versions pinned per run.
