# Maintenance

Append-only applies to the **capture** path. Deliberate, reviewed pruning by a
human is a separate act, and it is required — an unpruned file stops being read.

## Prune monthly

The failure mode is specific: a dependency gets upgraded, and the note about
its old quirk silently turns from useful into **actively harmful advice**. It
still reads as authoritative. Nobody notices until an agent follows it.

Once a month, per file: does each entry still describe the code as it is now?
Delete what does not. Deletion is a commit, so nothing is truly lost.

## Resolve contradictions explicitly

One entry says "always do X", another says "X breaks here". An agent reading
both picks one, effectively at random, and you cannot tell which.

Do not leave both standing. Either delete the loser, or add an entry under
*Open Questions* stating which wins and when.

## Keep it from bloating

Past roughly **200 entries** in one file, signal-to-noise falls far enough that
the file stops being read. Two moves:

- **Cut** — the monthly prune, done seriously.
- **Split by domain** — `insights-auth.md`, `insights-database.md`, with the
  parent file linking to them. Split only at the threshold; premature splitting
  hides things.

Note: published guidance disagrees on this number — one source caps a CLAUDE.md
learnings section at 30 items, another consolidates at ~100. Those are for a
single always-loaded file. These files are per-package and loaded on demand, so
200 is the working threshold here. If a file becomes unpleasant to read before
then, that judgement wins over the number.

## Treat these files as a draft under review

**They are not the truth.** A wrap-up does maybe 90% of the work, but an LLM
summarising its own session can be confidently wrong about what actually
happened — especially about cause.

Spot-check entries written on your behalf. An entry that misidentifies a cause
is worse than no entry: it sends the next reader somewhere specific and wrong.

## Version in git

These files are committed, which buys three things: the evolution of the team's
understanding is visible; a bad wrap-up can be reverted; lessons are shared
rather than trapped in one person's session.

It also means a merge conflict is a moment where a lesson can quietly vanish.
When resolving one in an `insights.md`, **keep both sides**. Entries are
independent; there is no reason to choose.

---

# L06 — making capture unconditional

Today capture depends on the skill being invoked, by its description or by
`/engineering-insights`. That is honest but not reliable: one field report puts
"the agent didn't think to look" at roughly **1 in 5** sessions.

Two hooks close the gap. Neither is installed — L01 is deliberately hook-free.
Verify the exact schema against the hooks documentation before adding either.

**`Stop` — capture becomes automatic.** Fires when the session ends; runs the
three gates without anyone remembering to.

**`PreToolUse` on `Write` — the append-only guarantee becomes unconditional.**
`disallowed-tools: Write` in `SKILL.md` only protects turns where the skill is
active. A `PreToolUse` hook matching `Write` and rejecting any path ending in
`insights.md` (exit code 2 blocks the call) protects every turn, including ones
where the skill never loaded.

Sketch, for `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          { "type": "command", "command": ".claude/skills/engineering-insights/deny-write.sh" }
        ]
      }
    ]
  }
}
```

The script reads the tool input on stdin and exits 2 when the target path ends
in `insights.md`, with a message telling the agent to use `Edit` plus
`guard.sh`. `deny-write.sh` is not written yet — it belongs with the hook.