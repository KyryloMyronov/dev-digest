/* TokenCount — one document's persisted token count, or its pending indicator.

   Promoted to src/components/ because TWO routes render it: the agent editor's
   Context tab and the skill editor's Context surface. That is exactly the bar
   `client/AGENTS.md` sets for promotion out of a route's `_components/`.

   AC-35 is the whole reason this is a component and not a template literal: a
   `null` count must reach the ACCESSIBILITY TREE as a pending indicator, not as
   a dash in a span with no accessible text. `null` is "not counted yet"; it is
   never zero.

   NO i18n INSIDE, deliberately. Each screen owns its own message catalogue
   (`messages/en/agents.json`, `messages/en/skills.json`), so a shared component
   that resolved its own namespace would drag one screen's catalogue into the
   other's — which is exactly how the skill editor ended up depending on the
   Project Context page's messages. The labels arrive as props instead. */
"use client";

import React from "react";

export function TokenCount({
  tokens,
  format,
  pendingLabel,
}: {
  tokens: number | null | undefined;
  /** e.g. `(n) => t("context.tokens", { count: n })`. */
  format: (count: number) => string;
  /** e.g. `t("context.tokensPending")`. */
  pendingLabel: string;
}) {
  const pending = tokens === null || tokens === undefined;
  const text = pending ? pendingLabel : format(tokens);

  return (
    <span
      className="tnum"
      // Text content is already in the accessibility tree; the title adds the
      // same words on hover for sighted users of a narrow row.
      title={text}
      style={{ fontSize: 12, color: pending ? "var(--text-muted)" : "var(--text-secondary)" }}
    >
      {text}
    </span>
  );
}
