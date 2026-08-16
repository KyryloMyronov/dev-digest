# Importable skills

Markdown skills meant to be brought into a workspace through **Skills → Add →
Import**, rather than seeded.

They exist so the import path can be walked end to end — pick a file, read the
preview, confirm — against a skill the workspace genuinely does not have yet. A
seeded skill would make that demo a no-op.

## File shape

The importer accepts a single `.md` file, or a `.zip` containing one (any
`SKILL.md`, or the archive's only markdown file, is taken as the core; every
other member is ignored). YAML frontmatter supplies the metadata:

```markdown
---
name: my-skill
description: Apply when … . Report … .
type: rubric | convention | security | custom
---

# Body

Markdown from here down becomes the skill body.
```

`name` falls back to the filename and `type` to `custom` when absent, so a skill
written for another tool still imports. Everything after the frontmatter is the
body, verbatim.

## What the importer does NOT do

- It does not execute anything. Scripts, hooks, manifests and binaries inside an
  archive are listed in the preview and then dropped — only markdown is read.
- It does not fetch anything. A URL in a body is text.
- It does not save without confirmation. The preview shows the exact body that
  would be stored, and nothing is written until you accept it.

## Trust

An imported skill is **someone else's instructions inside your agent's prompt**.
It is not wrapped in the `<untrusted>` delimiters the diff and PR description
get, because that same wrapper tells the model to treat its contents as inert
data — which would neutralise the skill you just attached. The block is labelled
`source: imported` in the assembled prompt and badged in the UI instead.

So: read the body in the preview before you accept it, the same way you would
read a dependency you are about to add. A skill that tells a reviewer to ignore a
class of finding will be obeyed.

| File | What it adds |
|---|---|
| [`test-flake-signals.md`](./test-flake-signals.md) | Flaky-test patterns, for the Test Quality Reviewer |
| [`control-experiment.md`](./control-experiment.md) | How to run the same agent on the same PR with its skills off, then on |
