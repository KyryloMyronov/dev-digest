# References

## Sources

- **[Claude Code — Extend Claude with skills](https://code.claude.com/docs/en/skills)**
  Frontmatter reference and invocation mechanics. Load-bearing here:
  `description` drives automatic invocation and is truncated at 1,536 characters
  in the skill listing, so the key use case goes first; `disallowed-tools`
  *removes* a tool from the pool while the skill is active, which is what makes
  the `Write` block a guarantee rather than a request; `allowed-tools` accepts
  scoped Bash patterns and grants only for the invoking turn; supporting files
  keep `SKILL.md` short (under 500 lines).

- **[How We Make Claude Remember: Learnings Over Skills](https://dev.to/evoleinik/how-we-make-claude-remember-learnings-over-skills-6h4)** — Eugene Oleinik
  Source of the measured failure rate this design is built around: recall fails
  "roughly 1 in 5 times" when the agent doesn't think to look. That is why the
  RECALL rule lives in the root `CLAUDE.md`, which is always in context, rather
  than in this skill, which is not. Also the split-by-domain pattern and the
  three-tier split (critical → `CLAUDE.md`, detail → learnings, procedure →
  skill), which the existing header of every `insights.md` already describes.

- **[CLAUDE.md: Building Persistent Memory for AI Coding Agents](https://dev.to/evoleinik/claudemd-building-persistent-memory-for-ai-coding-agents-5322)** — Eugene Oleinik
  The five-minute test used as the final filter in `rubrics.md`, the monthly
  prune, and the 5 MB Prisma Accelerate entry used as the model of an
  actionable note.

- **[How to build a learnings loop with Claude Code skills](https://www.mindstudio.ai/blog/how-to-build-learnings-loop-claude-code-skills)** — MindStudio
  Corroborates the double trigger (mid-session plus session-end plus periodic
  consolidation) and the entry criteria — specific, reusable, actionable,
  dated — which are folded into Gate 3.

## Provenance

The seven rubrics, the double trigger, the append-only rule, the
"actionable cold" quality bar, the maintenance rules, and the L01/L06 split
come from the course slides for this lesson (`img.png`, `img_1`–`img_6` at the
repo root). Where the slides and a source disagree, the slides win; the one
open disagreement — the pruning threshold — is recorded in `maintenance.md`.

Two deviations from the slides, both deliberate:

- The slides name the file `LEARNINGS.md` and place it per module. This repo
  already had `insights.md` in each package, referenced from every `CLAUDE.md`.
  A second file would have split the knowledge in two, which is the exact
  failure the slides warn about elsewhere.
- The slides show the rubrics as fixed sections. Entries here stay chronological
  with a `**Rubric:**` tag instead, so an append never edits inside a shared
  anchor. Rubrics are recovered with grep; the index sits at the top of each file.

## Not consulted

The slides also cite a Reddit r/ClaudeAI report. Only the slide's paraphrase was
available; the thread itself was not read.