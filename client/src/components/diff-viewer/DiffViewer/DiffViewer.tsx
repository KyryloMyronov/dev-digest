/* DiffViewer — basic GitHub-style unified diff viewer. Renders real PrFile.patch
   (unified-diff text from the F1 API) as a list of collapsible FileCards.
   Optional inline comments (Files changed tab): hover a line → "+" → comment,
   posted live to GitHub; existing GitHub review comments render inline.
   Optional `annotations` (L03 · Smart Diff) overlay the PR's review findings. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { PrFile } from "@/lib/types";
import { type DiffCommentApi } from "../comments";
import type { DiffAnnotations, DiffReveal } from "../annotations";
import { s } from "../styles";
import { FileCard } from "../FileCard";

export function DiffViewer({
  files,
  commenting,
  annotations,
  onFileOpenChange,
  reveal,
}: {
  files: PrFile[];
  commenting?: DiffCommentApi;
  /** Per-path review overlay; a path with no entry renders as a plain file. */
  annotations?: DiffAnnotations;
  /** Reports a manual fold/unfold of one file (session-sticky fold state). */
  onFileOpenChange?: (path: string, open: boolean) => void;
  /** Jump-to-line request; forwarded to the file it names. */
  reveal?: DiffReveal | null;
}) {
  const t = useTranslations("shell");
  if (!files || files.length === 0) {
    return <div style={s.empty}>{t("diffViewer.noChangedFiles")}</div>;
  }
  return (
    <div style={s.list}>
      {/* Keyed by path, not index: FileCard owns its expanded/collapsed state,
          and the file list changes shape when the PR gains a commit. With index
          keys, removing a file slides every card's open state onto its
          neighbour. Paths are unique within a PR by definition. */}
      {files.map((f) => (
        <FileCard
          key={f.path}
          file={f}
          commenting={commenting}
          annotation={annotations?.[f.path]}
          onOpenChange={onFileOpenChange}
          reveal={reveal && reveal.path === f.path ? reveal : null}
        />
      ))}
    </div>
  );
}
