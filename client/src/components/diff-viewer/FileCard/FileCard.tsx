/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count, review-finding badge) and, when open, its parsed lines plus any
   outdated comments. An annotation (L03 · Smart Diff) adds the finding badge,
   highlights the lines findings point at, and can force the open state.

   SPEC-03 adds four things: the header's fold affordance becomes a REAL button
   exposing `aria-expanded` (AC-69/AC-70), the file's derived one-line summary
   renders between the header and the body (AC-49/AC-50/AC-58), a per-file
   derivation control sits in the header (AC-51/AC-52/AC-53), and each flagged
   line carries its finding's severity as an icon AND a text label
   (AC-65/AC-66/AC-72).

   EVERY user-facing string this component renders arrives RESOLVED, on the
   annotation or on `DiffSummaryApi.labels` — a shared component that resolves
   its own i18n namespace crashes any screen whose catalogue lacks it (client
   insights.md 2026-08-27). The one `useTranslations("shell")` below predates
   SPEC-03 and is the diff viewer's own namespace, carried by every screen that
   mounts it. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, SeverityBadge } from "@devdigest/ui";
import type { PrFile } from "@/lib/types";
import { AUTO_EXPAND_MAX_LINES } from "../constants";
import { parsePatch, type Line } from "../helpers";
import {
  buildThreads,
  keysForLine,
  partitionThreads,
  type CommentThread,
  type DiffCommentApi,
} from "../comments";
import { worstSeverity, type DiffAnnotation } from "../annotations";
import type { DiffSummaryApi } from "../summary";
import { s, chevronFor } from "../styles";
import { CodeLine } from "../CodeLine";
import { OutdatedComments } from "../OutdatedComments";

/** Threads anchored to a given parsed line (RIGHT=new, LEFT=old). */
function threadsForLine(ln: Line, matched: Map<string, CommentThread[]>): CommentThread[] {
  if (matched.size === 0) return [];
  const out: CommentThread[] = [];
  for (const key of keysForLine(ln)) {
    const list = matched.get(key);
    if (list) out.push(...list);
  }
  return out;
}

export function FileCard({
  file,
  commenting,
  annotation,
  summary,
  onOpenChange,
  reveal,
}: {
  file: PrFile;
  commenting?: DiffCommentApi;
  annotation?: DiffAnnotation;
  /** SPEC-03 — how to REQUEST a derivation. The summary DATA rides on
   *  `annotation.summary`; only the callback and its resolved labels are here
   *  (plan D-8), mirroring how `commenting` reaches this component. */
  summary?: DiffSummaryApi;
  /** Reports a MANUAL fold/unfold, so the owner can remember it for the session. */
  onOpenChange?: (path: string, open: boolean) => void;
  /** Jump-to-line request for THIS file (already filtered by path upstream). */
  reveal?: { line: number | null; token: number } | null;
}) {
  const t = useTranslations("shell");
  // An annotation's `defaultOpen` wins over the size rule: Smart Diff knows
  // which files are generated boilerplate, and no line count implies that.
  const [open, setOpen] = React.useState(
    annotation?.defaultOpen ?? (file.additions ?? 0) + (file.deletions ?? 0) <= AUTO_EXPAND_MAX_LINES
  );
  const lines = React.useMemo(() => parsePatch(file.patch), [file.patch]);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Jump-to-finding: open the card, centre the target row, pulse it. The
  // scroll waits a tick so the body exists when the card was collapsed. A line
  // the patch doesn't contain degrades to centring the card itself — the
  // finding card already carries the "not in this diff" mark. Shared by the
  // external reveal request and the header's finding-badge click.
  const [flashLine, setFlashLine] = React.useState<number | null>(null);
  const jumpTimers = React.useRef<number[]>([]);
  const jumpToLine = React.useCallback((line: number | null) => {
    setOpen(true);
    jumpTimers.current.forEach((id) => window.clearTimeout(id));
    const scroll = window.setTimeout(() => {
      const row =
        line != null ? rootRef.current?.querySelector(`[data-new-line="${line}"]`) : null;
      (row ?? rootRef.current)?.scrollIntoView({ behavior: "smooth", block: "center" });
      // SPEC-02 AC-50 — reveal now moves keyboard focus, for EVERY caller: the
      // brief's risk/focus jumps, the findings tab's jumpToFinding, and the blast
      // card's jumpToFile. Author-signed-off behaviour change, not a side effect.
      //
      // `preventScroll: true` is not cosmetic: without it the browser's own
      // focus scroll fights the smooth `scrollIntoView` immediately above.
      // Focus lands on the CARD (`rootRef`), which carries `tabIndex={-1}` —
      // a diff row is not focusable and the criterion names the file card.
      rootRef.current?.focus({ preventScroll: true });
      if (row) setFlashLine(line);
    }, 60);
    const clear = window.setTimeout(() => setFlashLine(null), 2100);
    jumpTimers.current = [scroll, clear];
  }, []);
  React.useEffect(() => {
    if (reveal) jumpToLine(reveal.line);
    return () => jumpTimers.current.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(file.path, next);
  };

  // Findings anchor to NEW-side line numbers, which is what `newNo` carries.
  const findingLines = annotation?.findingLines;
  const findingLineSet = React.useMemo(() => new Set(findingLines ?? []), [findingLines]);
  const severity = worstSeverity(annotation?.severities);

  // Clicking the finding badge jumps to the finding lines (cycling through
  // them on repeat clicks) instead of bubbling into the header's fold toggle.
  const sortedFindingLines = React.useMemo(
    () => [...new Set(findingLines ?? [])].sort((a, b) => a - b),
    [findingLines],
  );
  const nextFinding = React.useRef(0);
  const onFindingBadgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const line = sortedFindingLines[nextFinding.current % sortedFindingLines.length]!;
    nextFinding.current += 1;
    jumpToLine(line);
  };

  // Group this file's comments into threads, then split into ones we can anchor
  // to a rendered line vs. "outdated" (GitHub dropped the line / it's not here).
  const comments = commenting?.comments;
  const { matched, outdated } = React.useMemo(() => {
    if (!comments) return { matched: new Map<string, CommentThread[]>(), outdated: [] };
    const fileThreads = buildThreads(comments.filter((c) => c.path === file.path));
    const renderedKeys = new Set<string>();
    for (const ln of lines) for (const k of keysForLine(ln)) renderedKeys.add(k);
    return partitionThreads(fileThreads, renderedKeys);
  }, [comments, file.path, lines]);

  const commentCount = commenting
    ? commenting.comments.filter((c) => c.path === file.path).length
    : 0;

  // AC-51 / AC-52 / AC-53 / AC-63 — the per-file derivation control.
  //
  //   AC-51  offered whenever this file has no stored summary
  //   AC-52  disabled when the file has no patch, with the reason IN THE NAME
  //   AC-53  the accessible name states that activating it spends a model call
  //   AC-63  disabled while a PR-LEVEL derivation is in flight
  //
  // Three renderings stay distinguishable, which is the whole point of D-8's
  // split: never derived (offered), no patch (disabled), summary present (no
  // control). A failed derivation persists no row, so the file returns to the
  // offered state on its own.
  const noPatch = file.patch == null;
  const deriving = !!summary?.pending.has(file.path);
  const deriveControl =
    summary && !annotation?.summary ? (
      <button
        type="button"
        style={s.deriveBtn}
        disabled={noPatch || deriving || summary.prLevelPending}
        aria-label={noPatch ? summary.labels.noPatch : deriving ? summary.labels.deriving : summary.labels.derive}
        onClick={() => summary.onDerive(file.path)}
      >
        <Icon.Sparkles size={12} />
        {deriving ? summary.labels.deriving : summary.labels.derive}
      </button>
    ) : null;

  return (
    // `tabIndex={-1}`: programmatically focusable (SPEC-02 AC-50) but never a
    // tab stop, so the Tab order through the diff is unchanged.
    <div ref={rootRef} tabIndex={-1} style={s.fileCard}>
      {/* D-3 — the header row is NOT interactive. It already owned one nested
          button (the finding-jump badge) and AC-51 adds a second, and a
          <button> may not contain interactive descendants. So the fold
          affordance is the nested disclosure button below; the tag, the
          severity badge, the derive control and the comment count are its
          SIBLINGS. Accepted cost: clicking the badge strip no longer folds. */}
      <div style={s.fileHeader}>
        {/* AC-69 / AC-70 — a real <button>, so Enter AND Space fold it with no
            `onKeyDown` of our own; a hand-rolled key handler is exactly where
            the Space case gets missed. Its accessible name is the PATH: never
            add an `aria-label` that REPLACES it — `aria-label` beats the
            element's own text, which is how SPEC-02's AC-45 defect shipped
            (client insights.md 2026-08-28). AC-62: the raw path is the name
            even when CSS truncates it visually. */}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          style={s.fileDisclosure}
          title={file.path}
        >
          <Icon.ChevronRight size={13} style={chevronFor(open)} />
          <Icon.FileText size={14} style={s.fileIcon} />
          <span className="mono" style={s.filePath}>
            {file.path}
          </span>
          <span className="mono tnum" style={s.fileStat}>
            <span style={s.addText}>+{file.additions}</span>{" "}
            <span style={s.delText}>−{file.deletions}</span>
          </span>
        </button>
        {annotation?.tag && (
          <Badge color={annotation.tag.color} bg={annotation.tag.bg}>
            {annotation.tag.label}
          </Badge>
        )}
        {/* Not `compact`: the compact badge drops the label and leaves colour
            plus an icon carrying the meaning, which the kit's own note calls
            out as the thing not to do. */}
        {severity &&
          (sortedFindingLines.length > 0 ? (
            <button
              type="button"
              style={s.findingJump}
              title={t("diffViewer.jumpToFinding")}
              onClick={onFindingBadgeClick}
            >
              <SeverityBadge severity={severity} count={annotation?.severities?.length} />
            </button>
          ) : (
            <SeverityBadge severity={severity} count={annotation?.severities?.length} />
          ))}
        {commentCount > 0 && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}
          >
            <Icon.MessageSquare size={12} />
            {commentCount}
          </span>
        )}
        {deriveControl}
      </div>
      {/* AC-54 — a skeleton in place of the summary line while the read is in
          flight, so a file with a summary does not pop in over a blank row.
          `aria-hidden`: it carries no information, and the tab's status region
          is what announces the state change (AC-71). */}
      {summary?.loading && !annotation?.summary && (
        <div style={s.summaryRow} aria-hidden="true" data-summary-skeleton>
          <span style={s.summarySkeleton} />
        </div>
      )}
      {annotation?.summary && (
        // AC-49 / AC-50 — between the header and the body, so it renders in
        // BOTH views: a summary is a property of the FILE, not of the view, and
        // `DiffViewer` is the single component the smart groups and the flat
        // list both render. Nothing view-specific is needed for AC-50.
        //
        // AC-61 — rendered as TEXT. Never through Markdown, never
        // `dangerouslySetInnerHTML`, never as an href: a persisted summary is a
        // stored-XSS shape (attacker-influenced text, stored, then shown to
        // every later reader) and React's JSX escaping is the safety net.
        <div style={s.summaryRow}>
          <Icon.Sparkles size={12} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
          {/* AC-62 — truncated VISUALLY (CSS ellipsis) with the RAW value as the
              accessible name. `title` is hover only: `aria-label` beats it in
              the accessible-name computation, so setting both leaves `title`
              dead for naming. */}
          <span style={s.summaryText} aria-label={annotation.summary.text} title={annotation.summary.text}>
            {annotation.summary.text}
          </span>
          {/* AC-58 — badge the mismatch and KEEP the text: a stale summary is
              still information. */}
          {annotation.summary.stale && (
            <Badge icon="History" color="var(--warn)" bg="var(--warn-bg)">
              {annotation.summary.staleLabel}
            </Badge>
          )}
        </div>
      )}
      {open && (
        <div style={s.fileBody}>
          {lines.length === 0 ? (
            <div style={s.noDiff}>{t("diffViewer.noDiffText")}</div>
          ) : (
            // Index keys are correct here, unlike the file list above: `lines`
            // is a useMemo purely over `file.patch`, so it never reorders or
            // filters — it is replaced wholesale. A hunk header has neither
            // oldNo nor newNo, so there is no stable id to key on either.
            lines.map((ln, i) => (
              <CodeLine
                key={i}
                ln={ln}
                path={file.path}
                threads={threadsForLine(ln, matched)}
                commenting={commenting}
                finding={ln.newNo != null && findingLineSet.has(ln.newNo)}
                // AC-65 — the line's own worst severity, or undefined, in which
                // case AC-67's shipped severity-neutral highlight renders.
                severity={ln.newNo != null ? annotation?.severitiesByLine?.get(ln.newNo) : undefined}
                flash={flashLine != null && ln.newNo === flashLine}
              />
            ))
          )}
          {commenting && commenting.showComments && <OutdatedComments threads={outdated} />}
        </div>
      )}
    </div>
  );
}
