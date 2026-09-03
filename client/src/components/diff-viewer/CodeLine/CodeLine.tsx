/* CodeLine — one rendered diff line: gutter number, +/- sign, text, plus the
   hover "+" affordance, any anchored comment threads, and an inline composer.
   A line a review finding points at renders highlighted (L03 · Smart Diff).

   SPEC-03 AC-65/AC-66/AC-72: when that finding's severity resolves, the row
   also carries the severity as an ICON AND A TEXT LABEL — never colour alone,
   which is WCAG 2.2 · 1.4.1 and the reason the mockup's bare dot was rejected.
   The label sits in the gutter margin (plan D-9) so the code text does not
   move. `SeverityBadge compact` is NOT used: `compact` drops the label
   entirely (client insights.md 2026-08-18), which is the exact failure this
   criterion forbids. */
"use client";

import React from "react";
import { SEV, type Severity, Icon } from "@devdigest/ui";
import { commentTargetFor, type CommentThread, type DiffCommentApi, cs } from "../comments";
import { type Line } from "../helpers";
import { s, findingRowFor, lineRowFor, lineSignFor } from "../styles";
import { CommentThreadView } from "../CommentThreadView";
import { InlineComposer } from "../InlineComposer";

/**
 * The at-the-line severity mark: icon + MIXED-CASE label from `tokens.ts`.
 *
 * The label read here is `"Critical"` / `"Warning"` / `"Suggestion"` — the
 * all-caps look elsewhere in the product is `textTransform: uppercase`, a CSS
 * effect that never reaches the DOM, so a test asserts `"Critical"`.
 */
function SeverityMark({ severity }: { severity: Severity }) {
  const sev = SEV[severity];
  const I = Icon[sev.icon];
  return (
    <span style={{ ...s.lineSeverity, color: sev.c }}>
      <I size={11} />
      {sev.label}
    </span>
  );
}

export function CodeLine({
  ln,
  path,
  threads,
  commenting,
  finding,
  severity,
  flash,
}: {
  ln: Line;
  path: string;
  threads: CommentThread[];
  commenting?: DiffCommentApi;
  /** A review finding anchors to this line — render it as the eye-catch. */
  finding?: boolean;
  /**
   * SPEC-03 AC-65 — the WORST severity of the findings on this line. Absent (or
   * null) with `finding` true is AC-67: the shipped severity-neutral highlight,
   * byte-identical to what shipped before this feature.
   */
  severity?: Severity | null;
  /** This row is the target of a jump-to-finding — pulse it once. */
  flash?: boolean;
}) {
  const [hover, setHover] = React.useState(false);
  const [composing, setComposing] = React.useState(false);

  if (ln.kind === "hunk") {
    return (
      <div className="mono" style={s.hunk}>
        {ln.text}
      </div>
    );
  }

  const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : "";
  const target = commenting?.canComment ? commentTargetFor(ln) : null;
  const showAdd = hover && !!target && !composing;

  return (
    <div
      style={cs.rowWrap}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          ...(finding ? findingRowFor(ln.kind, severity) : lineRowFor(ln.kind)),
          ...(flash ? { animation: "ddFlash 1.9s ease-out" } : null),
        }}
        // `data-finding-line` and `data-new-line` are load-bearing: DiffTab's
        // tests and the page's jump path both query on them. Do not rename.
        data-finding-line={finding ? "true" : undefined}
        data-new-line={ln.newNo ?? undefined}
      >
        <span className="mono tnum" style={{ ...s.lineNo, position: "relative" }}>
          {showAdd && target && (
            <button
              type="button"
              title="Add a comment on this line"
              aria-label="Add a comment on this line"
              onClick={() => setComposing(true)}
              style={cs.addBtn}
            >
              +
            </button>
          )}
          {ln.newNo ?? ln.oldNo ?? ""}
        </span>
        {finding && severity && <SeverityMark severity={severity} />}
        <span className="mono" style={lineSignFor(ln.kind)}>
          {sign}
        </span>
        <span className="mono" style={s.lineText}>
          {ln.text || " "}
        </span>
      </div>

      {commenting &&
        commenting.showComments &&
        threads.map((th) => (
          <CommentThreadView key={th.rootId} thread={th} commenting={commenting} path={path} />
        ))}

      {commenting && composing && target && (
        <InlineComposer
          commenting={commenting}
          path={path}
          line={target.line}
          side={target.side}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}
