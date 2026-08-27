# `spec-creator/` — reference material, not a skill

There is no `SKILL.md` here, so nothing in this folder is loadable with the
`Skill` tool. `spec-creator` is a **subagent**:
[`.claude/agents/spec-creator.md`](../../agents/spec-creator.md).

The three files under [`references/`](references/) stayed behind because they are
long, stable, and read on demand rather than on every invocation — inlining them
would triple the agent's prompt for no gain:

| File | What it decides |
|---|---|
| [`references/template.md`](references/template.md) | the 14 spec sections, their order, and what disqualifies a line in each |
| [`references/ears.md`](references/ears.md) | EARS patterns, worked examples, the anti-pattern list, the coverage rule |
| [`references/design-review.md`](references/design-review.md) | the four-axis checklist run over every design image |

`template.md` is mirrored for humans in [`specs/README.md`](../../../specs/README.md).
Change one, change both.

Paths here are cited from the agent file. Moving this folder means editing
`.claude/agents/spec-creator.md`.
