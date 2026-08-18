---
name: source-scan
description: "The shared source scanner behind this repo's static-analysis skills — git-ref file I/O (read any path at any ref with no checkout) plus a bracket-aware TS/JS text scanner (balanced slicing, comment stripping, top-level splitting, line numbers). Read this before writing or changing a check that parses TypeScript without compiling it, before adding a primitive to it, and before anchoring a balanced slice at a `<`. Imported by api-breaking-changes, api-response-changes and response-schema."
version: 0.1.0
---

# source-scan

A **library, not a workflow.** There is nothing to run and no report to read.
Three skills need the same two capabilities, and this is where they live:

1. **git-ref I/O** — read any path at any ref with no checkout, no install, no
   tsconfig, including the uncommitted working tree.
2. **a bracket-aware TS/JS scanner** — pull structure out of source text without
   the TypeScript compiler.

Load it when you are **writing or changing** one of those checks. If you just
want to know whether a change breaks the API, run the skills instead:
`api-breaking-changes`, `api-response-changes`, `response-schema`.

## Why one copy

This logic existed twice — in `api-breaking-changes/surface.mjs` and
`response-schema/lib.mjs` — and the two copies drifted on the single detail that
matters most: whether `<` belongs in the bracket-pairing table. One copy said no
and silently truncated every generic it was asked to slice; the other said yes.
That cost a silent wrong answer (every contract name resolving to `null` while
the tool still reported success) and two entries in the root `insights.md`, the
second superseding the first.

The scanner is now one implementation with one documented invariant. The two
insight entries remain accurate about the *hazard*; they describe a divergence
that no longer exists in the code.

## The API

```js
import { readAt, listFiles, WORKTREE, sliceBalanced, … } from '../source-scan/scan.mjs';
```

| Export | Does |
|---|---|
| `REPO_ROOT`, `git(args, {soft})` | repo root; run git, `soft` turns non-zero into `null` |
| `globToRegExp(glob)`, `matchesAny(path, patterns)` | `**` any depth, `*` one segment, `?` one char; results cached |
| `WORKTREE` | sentinel ref meaning "the working tree", so a check runs pre-commit |
| `listFiles(ref)` | tracked paths at `ref`; tracked **+ untracked** for `WORKTREE` |
| `readAt(ref, path)` | file content at `ref`, or `null` when absent there |
| `skipString(src, i)` | index past the string at `i`, handling `${…}` in templates |
| `sliceBalanced(src, openIdx)` | `{ inner, end }` for the bracket at `openIdx`; `unbalanced: true` on the run-to-end fallback |
| `stripComments(src)` | drop comments, **keep every newline** so line numbers still match |
| `splitTopLevel(text, seps=[','])` | split on top-level separators; pass `[',', ';']` for a TS type literal |
| `readExpression(src, i)` | the expression at `i`, to the top-level `;` |
| `lineAt(src, idx)` | 1-based line number, for `file:line` output |
| `stringLiteral(text)` | `'/agents'` → `/agents`, else `null` |

## The angle-bracket rule

The one thing to get right, and the reason this file has a skill doc at all.

`<` **is** in `PAIRS`, and that is safe for every caller. `sliceBalanced` moves
depth only on `c === open` or `c === close`, where `open` is the character at the
index you pass. So `<` participates in depth **only when you anchor the slice at
a `<` yourself.** Inside a `(`, `{` or `[` slice it is an ordinary character, and
`a < 5 && b > 3` cannot unbalance anything.

The hazard was never the pairing table — it is the call site:

- **Do** anchor at a `<` you have already proved opens a generic: after matching
  `/\bapi\s*\.\s*get\s*(?=<)/`, or at `t.indexOf('<')` in a string you already
  know is a type expression. `extractCallerBindings` in
  `../response-schema/responses.mjs` is the worked example.
- **Do not** go hunting for the next `<` in arbitrary source, where it may be a
  comparison, JSX, or the arrow of `=>`.
- **Do not slice at all** for a *fully wrapped* generic. Match greedily to the
  final `>` instead — `new RegExp('^' + wrapper + '\\s*<([\\s\\S]*)>$')` — which
  is what `parseTypeExpr` in `../api-response-changes/response-surface.mjs` does.
  It is cheaper and cannot be thrown off by a nested arrow.

`=>` is stepped over before any depth accounting, so an arrow inside a type
literal (`Array<{ cb: (x: number) => boolean }>`) cannot close an angle depth.
That step is harmless for the other three bracket kinds, whose open and close
characters are never `=` or `>`.

## Never reach for the TypeScript compiler here

Every caller has the same three constraints, and they are what rule the compiler
out:

- it reads `git show <ref>:<path>` with **no checkout** — there is no file tree to
  point a program at;
- it runs with **no install and no tsconfig**, including in CI jobs that check out
  only `.claude/`;
- it must survive a branch whose code **does not typecheck yet**, which is exactly
  when a pre-PR check is most useful.

The parse is deliberately shallow. Each calling skill documents what that costs
*it* under its own "Parsing limits" — that is the right place for those, because
the cost depends on what is being modelled, not on the scanner.

## Changing this file

Every consumer is a differential tool: it compares two refs, so a scanner bug
shows up as a *missing* finding, not a crash. Verify against fixed invariants
rather than eyeballing a report.

```sh
# these numbers must not move unless you intended them to
node .claude/skills/api-breaking-changes/surface.mjs   | grep -c '"method"'    # 101 routes
node .claude/skills/response-schema/responses.mjs      | grep -c '"typeText"'  # 47 caller bindings
node .claude/skills/api-response-changes/response-surface.mjs --summary | wc -l # 53 endpoints
```

The stronger check is a before/after diff of full output, which is how this
extraction was validated — all six surface and check outputs were byte-identical
across the three skills:

```sh
for s in api-breaking-changes/surface api-response-changes/response-surface response-schema/responses; do
  node .claude/skills/$s.mjs > /tmp/$(basename $s).before.json
done
# …make the change…
for s in api-breaking-changes/surface api-response-changes/response-surface response-schema/responses; do
  node .claude/skills/$s.mjs > /tmp/$(basename $s).after.json
  diff -q /tmp/$(basename $s).{before,after}.json
done
```

- **A new primitive** belongs here only if two or more skills need it. One caller
  needing something clever keeps it in that caller.
- **Do not add a `strict`/`legacy` flag** to restore an old behaviour. Two
  behaviours behind one name is how the copies drifted in the first place; if two
  callers genuinely need different semantics, they need two named functions.

## Known remaining duplication

`../pr-self-review/lib.mjs` still has its own `git`, `REPO_ROOT`, `globToRegExp`
and `matchesAny`. That is deliberate and out of scope here: it is a changeset
collector (`contentHash`, `addedLines`, `gitZ`, `readRepoFile`, severity
ordering), it contains **no source scanner**, and it has its own consumers to
re-verify. Nothing cross-skill imports it any more. Folding its four overlapping
helpers into this file is a reasonable follow-up, with `pr-self-review`'s own
before/after check as the gate.
