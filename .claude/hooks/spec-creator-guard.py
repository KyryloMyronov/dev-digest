#!/usr/bin/env python3
"""PreToolUse guard for the `spec-creator` agent.

Scoped by `agent_type`: every other caller — the main thread, `implementer`,
`test-writer`, `doc-writer` — passes through untouched. Only a tool call made
from inside a subagent whose type is `spec-creator` is inspected.

The agent may write specification files and nothing else:

    specs/SPEC-NN-slug.md                     cross-module specs
    specs/README.md                           the single global index
    specs/assets/SPEC-NN/**                   design images a spec cites
    <pkg>/specs/SPEC-NN-slug.md               single-module specs
    <pkg>/specs/README.md                     the folder's own pointer page
    <pkg>/specs/assets/SPEC-NN/**

    <pkg> ∈ server | client | reviewer-core | mcp

Everything else is denied, explicitly including `specs/plans/**` (Implementation
Plans, written by the main session) and `e2e/specs/**` (`.flow.json` browser
flows, not specifications).

Bash is allowed for read-only inspection only; anything that could mutate the
tree is denied here rather than trusted to the prompt.
"""

import json
import os
import re
import sys

AGENT = "spec-creator"
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}

PKG = r"(?:server|client|reviewer-core|mcp)"
# Two digits, widening to three past SPEC-99 — `\d{2}` would have denied SPEC-100
# outright. `assets/` takes nested paths: a spec may group its images per screen.
NUM = r"\d{2,}"
SPEC = rf"SPEC-{NUM}-[a-z0-9]+(?:-[a-z0-9]+)*\.md"
ASSETS = rf"specs/assets/SPEC-{NUM}/[^/]+(?:/[^/]+)*"

ALLOWED = [
    re.compile(rf"^specs/{SPEC}$"),
    re.compile(r"^specs/README\.md$"),
    re.compile(rf"^{ASSETS}$"),
    re.compile(rf"^{PKG}/specs/{SPEC}$"),
    re.compile(rf"^{PKG}/specs/README\.md$"),
    re.compile(rf"^{PKG}/{ASSETS}$"),
]

# Read-only shell only. Checked after the harmless redirections below are removed.
BASH_MUTATORS = re.compile(
    r"(^|[\s;&|(])("
    r"rm|rmdir|mv|cp|touch|mkdir|ln|tee|dd|truncate|chmod|chown|install"
    r"|patch|npm|pnpm|npx|yarn|docker|make"
    r"|git\s+(?:add|commit|push|checkout|switch|restore|reset|rebase|merge|apply|clean|stash|rm|mv|tag|branch)"
    r")([\s;&|)]|$)"
)
# In-place editors and inline interpreters: not inspection, and they bypass the
# path check by writing through a runtime rather than through a tool call.
BASH_INPLACE = re.compile(
    r"(^|[\s;&|(])("
    r"(?:sed|perl|ruby)\s+(?:-\S+\s+)*-\S*i"
    r"|python3?\s+(?:-\S+\s+)*-c"
    r"|node\s+(?:-\S+\s+)*-e"
    r"|(?:cat|tee)\s*<<"
    r")"
)
NOISE_REDIRECTS = re.compile(r"(?:\d?>>?\s*/dev/null|2>&1|\|\s*&)")
REDIRECT = re.compile(r"(?<![0-9<>])>>?(?!&)")


def deny(reason: str) -> None:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
    )
    sys.exit(0)


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def relative(path: str, cwd: str, root: str):
    if not os.path.isabs(path):
        path = os.path.join(cwd or root, path)
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return None if rel.startswith(os.pardir) else rel.replace(os.sep, "/")


def main() -> None:
    try:
        event = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # never break the session on a malformed payload

    if event.get("agent_type") != AGENT:
        sys.exit(0)

    tool = event.get("tool_name", "")
    payload = event.get("tool_input") or {}
    root = repo_root()
    cwd = event.get("cwd") or root

    if tool in WRITE_TOOLS:
        raw = payload.get("file_path") or payload.get("notebook_path") or ""
        if not raw:
            deny(f"{tool} without a file path. spec-creator writes specification files only.")

        rel = relative(raw, cwd, root)
        if rel is None:
            deny(f"`{raw}` resolves outside this repository. spec-creator writes inside `specs/` folders only.")

        if rel.startswith("specs/plans/"):
            deny(
                f"`{rel}` is an Implementation Plan. Plans are written by the main session after the "
                "author approves what implementation-planner produced — a spec says *what* and *why*, "
                "a plan says *how*. Report what the plan would need instead of writing it."
            )
        if rel.startswith("e2e/specs/"):
            deny(f"`{rel}` is an e2e browser flow (`.flow.json`), not a specification. That folder is off limits.")

        if not any(p.match(rel) for p in ALLOWED):
            deny(
                f"`{rel}` is outside spec-creator's write scope. Allowed: "
                "`specs/SPEC-NN-slug.md`, `specs/README.md`, `specs/assets/SPEC-NN/**`, and the same three "
                "under `server/`, `client/`, `reviewer-core/`, `mcp/`. "
                "If the task needs a file elsewhere, stop and say so — that work belongs to implementer, "
                "doc-writer, or the main session."
            )
        sys.exit(0)

    if tool == "Bash":
        command = payload.get("command", "")
        stripped = NOISE_REDIRECTS.sub("", command)
        if REDIRECT.search(stripped):
            deny("Shell redirection is a write. spec-creator writes files with the Write/Edit tools, which are path-checked.")
        for pattern in (BASH_MUTATORS, BASH_INPLACE):
            hit = pattern.search(stripped)
            if hit:
                deny(
                    f"`{hit.group(2).strip()}` can mutate the tree. spec-creator's Bash is for read-only "
                    "inspection (ls, cat, rg, grep, find, git log/show/diff)."
                )

    sys.exit(0)


if __name__ == "__main__":
    main()
