/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count, review-finding badge) and, when open, its parsed lines plus any
   outdated comments. An annotation (L03 · Smart Diff) adds the finding badge,
   highlights the lines findings point at, and can force the open state. */
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
  onOpenChange,
  reveal,
}: {
  file: PrFile;
  commenting?: DiffCommentApi;
  annotation?: DiffAnnotation;
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

  return (
    // `tabIndex={-1}`: programmatically focusable (SPEC-02 AC-50) but never a
    // tab stop, so the Tab order through the diff is unchanged.
    <div ref={rootRef} tabIndex={-1} style={s.fileCard}>
      <div onClick={toggle} style={s.fileHeader}>
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <Icon.FileText size={14} style={s.fileIcon} />
        <span className="mono" style={s.filePath}>
          {file.path}
        </span>
        <span className="mono tnum" style={s.fileStat}>
          <span style={s.addText}>+{file.additions}</span>{" "}
          <span style={s.delText}>−{file.deletions}</span>
        </span>
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
      </div>
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
