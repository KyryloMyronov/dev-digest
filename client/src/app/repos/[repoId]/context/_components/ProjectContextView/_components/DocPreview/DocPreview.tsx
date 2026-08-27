/* DocPreview — one document's text, rendered read-only.

   AC-11: rendered Markdown, and NO editing affordance anywhere. The renderer is
   the kit's `Markdown` primitive as installed, deliberately unchanged:
   `react-markdown@9.1.0` strips every non-allow-listed URL protocol before the
   custom `a` override sees the href, and escapes raw HTML because `rehype-raw`
   is absent from the tree. That is the control this pane relies on for
   repository-authored (i.e. untrusted) content — do NOT add `rehype-raw` here.

   AC-12: this pane's error is INLINE and local. The list stays interactive
   because the body is a separate query keyed by path, so a failed read of one
   document cannot take the list down with it. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Markdown, Skeleton } from "@devdigest/ui";
import type { ContextDocContent } from "@/lib/types";
import { formatBytes } from "../../helpers";
import { s } from "../../styles";

export function DocPreview({
  path,
  attachedAgents,
  data,
  isLoading,
  isError,
  errorBody,
  onRetry,
}: {
  path: string | null;
  /** AC-15 — how many agents attach this document, in its detail header. */
  attachedAgents: number | null;
  data: ContextDocContent | undefined;
  isLoading: boolean;
  isError: boolean;
  errorBody?: string;
  onRetry: () => void;
}) {
  const t = useTranslations("context");

  if (!path) {
    return (
      <div style={s.previewPanel}>
        <EmptyState icon="Eye" title={t("preview.noSelection")} />
      </div>
    );
  }

  return (
    <div style={s.previewPanel}>
      <div style={s.previewHeader}>
        <span className="mono" style={s.previewPath} title={path}>
          {path}
        </span>
        {attachedAgents !== null && (
          <span style={s.previewMeta}>{t("preview.attachedAgents", { count: attachedAgents })}</span>
        )}
        {data && <span style={s.previewMeta}>{formatBytes(data.size)}</span>}
      </div>
      <div style={s.previewBody}>
        {isLoading && <Skeleton height={220} />}
        {isError && !isLoading && (
          <ErrorState title={t("preview.loadError")} body={errorBody} onRetry={onRetry} />
        )}
        {!isLoading && !isError && data && <Markdown>{data.content}</Markdown>}
      </div>
    </div>
  );
}
