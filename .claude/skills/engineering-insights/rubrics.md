# The seven rubrics

One per entry. If an insight fits two, pick the one a future reader would
search under.

---

## What Works

An approach, sequence, or solution that turned out to be right, where the
alternative was not obvious.

Qualifies: "map-reduce only pays off past ~40 changed files; below that a
single call is faster and cheaper." · "seeding through `db:seed` rather than
fixtures keeps e2e and dev honest, because the seed *is* the contract."

Does not: "used TypeScript, worked well." Anything that would have been the
first guess anyway.

## What Doesn't Work

Dead ends and anti-patterns. **The most frequently skipped section and the most
valuable one** — a recorded dead end is the only kind of knowledge that never
arrives from reading the code, because the code does not contain what was tried
and abandoned.

Qualifies: "tried unifying both package managers on pnpm — `reviewer-core`'s
raw-source import breaks because the server resolves a second zod; reverted."

Does not: a bug you fixed in the normal course of work. That is just work. This
rubric is for the path that was taken and rejected.

## Codebase Patterns

A convention or architectural decision that exists in the code but is written
down nowhere, and that a newcomer would violate.

Qualifies: "the reported score is recomputed from findings that survived
grounding — never the model's self-reported number."

Does not: anything already in a `CLAUDE.md`. If it belongs there, promote it
and leave the entry here as the explanation.

## Tool & Library Notes

A quirk of a dependency, CLI, or runtime — behaviour that contradicts its docs
or that its docs bury.

Qualifies: "Prisma Accelerate caps responses at 5 MB — use `select`, not
`include`." · "`NEXT_PUBLIC_*` is inlined at build time; a restart is not
enough."

Does not: how the library works normally. Link its docs instead.

## Recurring Errors & Fixes

An error message seen more than once, paired with the fix. Include the literal
error text — that string is what someone will grep for.

Qualifies: "`ERR_PNPM_IGNORED_BUILDS` on install → a placeholder value in
`allowBuilds:` counts as unapproved; put real booleans there."

Does not: a one-off unlikely to recur.

## Session Notes

A dated summary that is genuinely worth keeping and fits no other rubric.
Use sparingly — this rubric attracts filler.

Does not: "worked on the reviewer module today."

## Open Questions

Left unresolved: latent risks, known constraints, contradictions between an
entry and the code.

Qualifies: "stale-run reaping assumes one API instance per DB; with replicas it
would reap live runs. No fix today — needs heartbeats first." · "`@devdigest/shared`
resolves backwards into `server/`; extracting `reviewer-core` requires moving
`shared` out first."

Write `**Symptom:** none yet — latent` when nothing has broken.

---

# What never belongs here

From the CLAUDE.md authoring rules, which apply the same way:

- **Detailed architecture** — that is `README.md` / `docs/`.
- **File-by-file description** — the agent reads the code.
- **Standard language rules** — TypeScript is not a discovery.
- **Anything the linter or typechecker catches** — the tool already says it.
- **Volatile data** — counts, versions in flux, current WIP state. It rots and
  becomes actively misleading.

And the deciding test, applied last:

> **Would this save someone five minutes the next time they hit this?**

No → do not write it. A file people trust is worth more than a complete one.