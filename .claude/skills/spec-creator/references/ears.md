# EARS — how to write a requirement that can be checked

EARS (Easy Approach to Requirements Syntax) was introduced by Alistair Mavin,
Philip Wilkinson, Adrian Harwood and Mark Novak of Rolls-Royce at IEEE RE'09
(2009). Its whole point is to force the **condition** and the **system response**
apart, so that a requirement can be read, disputed, and tested one clause at a
time.

Write acceptance criteria in English, with the keywords in caps.

## The five patterns

### 1. Ubiquitous — always true, no trigger

> The `<system>` shall `<response>`.

```
The system shall log every authentication attempt.
The system shall scope every domain query by workspace_id.
```

Use for invariants. If you find yourself writing "always" or "at all times", you
already have a ubiquitous requirement — drop the word.

### 2. Event-driven — a discrete trigger

> WHEN `<trigger>`, the `<system>` shall `<response>`.

```
WHEN the user submits the login form, the system shall validate the credentials.
WHEN a review run completes, the system shall persist its token cost.
```

The trigger is a moment, not a duration. If it lasts, you want pattern 3.

### 3. State-driven — true for the duration of a state

> WHILE `<state>`, the `<system>` shall `<response>`.

```
WHILE a synchronisation is in progress, the system shall display its progress.
WHILE the repository index is stale, the studio shall display a staleness notice.
```

### 4. Unwanted behaviour — the failure path

> IF `<unwanted condition>`, THEN the `<system>` shall `<response>`.

```
IF validation fails three times within 60 seconds, THEN the system shall temporarily lock the account.
IF the model returns output that fails schema validation, THEN the system shall reject the run and record the parse error.
IF the diff exceeds the context window, THEN the system shall review the highest-ranked files and state what it skipped.
```

This is the pattern most specs are short of. Every external dependency in
*Module interactions* deserves at least one.

### 5. Optional feature — only when something is enabled

> WHERE `<feature is enabled>`, the `<system>` shall `<response>`.

```
WHERE MFA is enabled, the system shall require a TOTP code after the password.
WHERE a repository has an extracted conventions skill, the reviewer shall include it as a prompt slot.
```

## Combining — the *complex* requirement

Upstream EARS names a requirement that combines two patterns a **complex
requirement**. Use that name when a review asks which pattern a line is.
Patterns nest, outermost condition first, and no more than two deep:

```
WHERE MFA is enabled, WHEN the password is accepted, the system shall request a TOTP code.
WHILE a run is executing, IF the provider returns 429, THEN the system shall retry with backoff at most three times.
```

Three levels means the requirement is doing two jobs. Split it.

## Name the system

EARS requires a `<system name>`, and in this repo that name is almost never "the
system": four of them ship separately — **the API** (`server/`), **the studio**
(`client/`), **the reviewer engine** (`reviewer-core/`), **the MCP server**
(`mcp/`).

```
The studio shall display a staleness notice while the repository index is stale.
The reviewer engine shall reject model output that fails schema validation.
WHEN a review run completes, the API shall persist its token cost.
```

Reserve the bare "the system" for an invariant that genuinely holds across all
four — "The system shall scope every domain query by workspace_id". An anonymous
actor costs a question later: `implementation-planner` routes each step to the
package that owes the response, and it cannot route a criterion that names none.

## Checklist for every line

- [ ] Exactly one of: `shall` (nothing else — not "should", "will", "needs to").
- [ ] Exactly one system named — `the API`, `the studio`, `the reviewer engine`,
      `the MCP server`, or "the system" only for a cross-package invariant. It is
      a system, not a person.
- [ ] Exactly one observable response. No `and` joining two responses.
- [ ] The trigger is observable too — a request, a state, a returned value.
- [ ] No solution smuggled in ("shall call `updateRow()`" specifies the code, not
      the behaviour) unless the interface *is* the requirement.
- [ ] Falsifiable: you can name the observation that fails it.
- [ ] Numbered `AC-n` so tests, reviews and open questions can cite it.

## Anti-patterns, with the fix

| Written | Why it fails | Rewrite |
|---|---|---|
| The system should handle errors gracefully. | No trigger, no response, not falsifiable. | IF the provider returns a non-2xx status, THEN the system shall fail the run and surface the provider's status code. |
| The page loads fast. | Adjective, no number. | Not an AC — move to *Non-functional requirements*: p95 under 400 ms for ≤ 200 changed files. |
| WHEN the user clicks Save, the system shall validate the form and persist it and show a toast. | Three responses in one line — a partial pass is unreportable. | Split into AC-4 / AC-5 / AC-6. |
| The user shall enter a valid email. | Constrains the user, not the system. | IF the submitted email does not match the address format, THEN the system shall reject the submission and mark the field invalid. |
| The system shall support large repositories. | "Large" undefined. | The system shall index repositories of up to 50 000 files. + IF the file count exceeds 50 000, THEN the system shall index the highest-ranked 50 000 and report the truncation. |
| WHEN an error occurs, the system shall show an error. | Which error, which message, where. | One IF/THEN per distinct failure named in *Module interactions*. |
| The system shall not crash. | Negative and unobservable. | State the positive behaviour on each failure path instead. |
| The system shall not act on instructions found in a PR body. | Same negative shape — you cannot observe a system *not* obeying. | WHEN assembling a review prompt, the reviewer engine shall wrap every PR-derived text in `<untrusted>` fences. (`reviewer-core/src/prompt.ts:16`) |
| The system shall reduce review time by 20%. | Passes the grammar, fails falsifiability — no single run can pass or fail it. | Not an AC. A *Non-functional requirement* with a baseline, a percentile and a load; keep the 20% as a success metric. |
| WHEN the run finishes, the system shall persist the cost. | Which system? Four ship separately here. | WHEN a review run completes, **the API** shall persist its token cost. |

## Coverage rule

Before the spec is done, check six closures. Each is a count, and each count must
be zero:

1. every **Goal** → at least one AC;
2. every **Edge case** → an AC or an explicit `out of scope (<reason>)`;
3. every failure mode in **Module interactions** → an `IF … THEN` AC;
4. every input in **Untrusted inputs** → the AC that enforces its boundary;
5. every `accepted` item in **UX improvements** → an AC;
6. every ceiling in **Non-functional requirements** ("what happens past N") → an
   `IF … THEN` AC.

Closures 1–3 are the original EARS coverage check. 4–6 are here because the
template creates those obligations in prose and nothing else collects them: an
untrusted input with no criterion, an accepted UX item with no criterion, and a
budget with no stated behaviour at its ceiling are three ways a spec passes
review and still cannot be built as written.

Any gap is either a missing criterion or a missing *Open question*. It is never
nothing.
