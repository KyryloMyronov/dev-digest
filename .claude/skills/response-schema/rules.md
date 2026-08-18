# Rules

One entry per `[rule]` tag emitted by `check.mjs`. Each says what actually
breaks for something reading the response, why it carries that severity, and the
way to ship the change anyway.

Severity is always from the **reader's** point of view — the studio, a CI
runner, someone's script:

| | Meaning |
|---|---|
| **critical** | a reader gets `undefined` where a value used to be |
| **major** | a reader must change to keep working — a value that can now be absent, null, or a different type |
| **minor** | nothing a reader does breaks; something that *builds* the payload must change, or a new case appears |
| **info** | wire-compatible, or the scanner could not model it and is saying so |

Every severity is lowered one step when no endpoint returns the type
(`nothing returns this type yet` in the report). This repo ships contracts ahead
of the features that use them — see `CLAUDE.md`. `--only-served` hides them.

---

## Payload shape

### `response-field-removed` — critical

The field is gone from the wire. Readers get `undefined` at runtime.

The type system does not save you here, twice over: the studio's types come from
the **hand-synced mirror**, so `tsc` on the client only notices after the mirror
is synced — until then both packages compile and the UI renders blanks. And
nothing type-checks a response against its handler at all.

**Ship it anyway:** update the studio code reading it in the same PR. For a
field with readers outside this repo, keep returning it for one release
alongside its replacement, then drop it in a follow-up.

### `response-field-now-optional` — major

The field was always present and can now be absent. Every reader written against
the old shape assumes presence — `data.score.toFixed(1)` was safe and is not any
more.

This is the rule `.partial()` triggers en masse: `X.partial()` flips every field
in one call, so one small-looking edit can produce a dozen of these. That is not
noise; it is the change.

**Ship it anyway:** give readers a default at the point of display, update them
in the same PR, or keep the field required and return an explicit empty value.

### `response-field-now-nullable` — major

The value can now be `null`. Same blast radius as above for anything that
dereferences it.

Before adding a default at the consumer, read the `cost_usd` entry in the root
`insights.md`: `null` and `0` are different facts — "not measured" is not
"free" — and coalescing them at the reader destroys the distinction permanently.
Resolve the display default in the UI, never in the contract.

### `response-field-type-changed` — major

The field's type changed (`z.string` → `z.number`, or one named schema swapped
for another). Serialized values change shape even when both packages compile.

The comparison is coarse — it sees `z.string`, not `.uuid()` — so tightening
`z.string()` to `z.string().uuid()` is a real change this rule stays silent
about. Treat that the same way even though nothing fires.

### `response-field-now-required` — minor

Optional → always present. Safe for readers, who already handle absence. It
breaks **producers**: the service, adapters, seeds, fixtures, and any handler
that builds this shape must now supply a value.

The `PrMeta` insight in the root `insights.md` is the worked example — a field
one endpoint cannot compute must be `.nullish()`, whatever it means
semantically.

### `response-field-added-required` — minor

A new always-present field. Additive for readers; every constructor of the shape
must now supply it. Minor because it normally lands with its producers in the
same PR.

A new *optional* field is not reported at all — it is the one genuinely
additive response change.

### `response-cardinality-changed` — critical

The payload became an array where it was an object, or the reverse. Every reader
breaks immediately: `data.map` on an object, `data.id` on an array.

**Ship it anyway:** this is a new endpoint wearing an old path. Prefer adding
one and deprecating the old, so callers migrate on their own schedule.

### `response-type-changed` — major

The shape changed kind in a way that is not an array/object flip — a scalar
became an enum, a union gained or lost an arm, a tuple changed length.

---

## Enums

### `response-enum-value-removed` — major

A value the response could return is gone. A reader with an exhaustive `switch`
is fine; one that round-trips the value back to the API is not, and neither is
anything already persisted with the old value — that fails to parse on read.

**Ship it anyway:** migrate the stored data in the same change, or keep the value
and mark it deprecated in the contract.

### `response-enum-value-added` — minor

Forward-compatible on the wire — nothing 500s. But exhaustive `switch`es, badge
colour maps, and label lookups in the studio all need the new case, and a missing
one usually shows up as an unstyled blank rather than an error.

---

## Types and endpoints

### `response-type-removed` — critical

An exported contract disappeared from `shared`. Anything importing it stops
compiling; anything parsing that payload stops working.

Remember `CLAUDE.md`: **this is a course starter, schema and contracts exist
ahead of the features that use them.** A contract with no module behind it is
not dead — do not "clean up" the barrel. The report says
`nothing returns it today` precisely so this is a decision, not a tidy-up.

### `response-binding-changed` — major

The endpoint's declared response type was swapped — `api.get<Agent>` became
`api.get<AgentDetail>`. Reported as the swap rather than a field-by-field diff,
because a diff between two different types restates the swap in a hundred lines.

Check what the endpoint's handler actually returns now. Since nothing verifies a
client generic against its handler, a swap is equally likely to be someone
*correcting* a generic that was already wrong — worth knowing either way.

### `response-binding-removed` — info

Nothing declares a response type for that endpoint any more: the studio call site
was deleted or retyped. Not a wire break on its own — the endpoint may serve
callers outside this repo — so it is listed for contrast, not as a break.

---

## Mirror

### `response-mirror-drift` — major

`server/src/vendor/shared/**` and `client/src/vendor/shared/**` describe
different payloads for the same contract, in a file this change touched. Both
packages still typecheck — that is exactly the failure the mirror exists to hide
and this rule exists to surface.

Compared by resolved **shape**, not by file text, so formatting and comment
differences never fire it, and a real field difference always does even when the
files were synced by hand.

**Fix:** `./scripts/check-contracts.sh --fix`, then `cd client && pnpm
typecheck`. Two things to expect, both in the root `insights.md`: the sync is
one-directional (server wins), and it will also land *pre-existing* drift from
earlier changes. Do not revert those extra files — call them out separately in
the PR. A client that stops compiling after the sync is the real bug the guard
found.

Only contracts in files this change touched are checked, so pre-existing drift
alone never fires this rule.

---

## Honesty

### `response-shape-opaque` — info

The shape changed somewhere the scanner cannot model — inside a `.transform()`,
a `z.lazy()`, or an expression it could not parse — and it says so rather than
staying silent, because silence reads as "nothing changed".

Diff that region by hand. If the scanner should have understood it, that is a
`responses.mjs` bug worth fixing rather than a finding to wave through; see
**Parsing limits** in [`SKILL.md`](SKILL.md).
