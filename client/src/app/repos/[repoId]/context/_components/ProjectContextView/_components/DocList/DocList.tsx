/* DocList — the discovered documents, or the state that replaces them.

   Owns exactly four presentations of the list region (AC-7 through AC-10 and
   AC-14): skeleton rows, an error state with retry, the empty state naming the
   three roots, and the rows themselves. The "still cloning" state (AC-5) is a
   DIFFERENT state and belongs to the view, not here — it is about the
   repository, not about the list. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import type { ContextDocList } from "@/lib/types";
import { SKELETON_ROWS, SKELETON_ROW_HEIGHT } from "../../constants";
import { s } from "../../styles";
import { DocRow } from "../DocRow";

export function DocList({
  data,
  isLoading,
  isError,
  errorBody,
  selected,
  onSelect,
  onRetry,
}: {
  data: ContextDocList | undefined;
  isLoading: boolean;
  isError: boolean;
  errorBody?: string;
  selected: string | null;
  onSelect: (path: string) => void;
  onRetry: () => void;
}) {
  const t = useTranslations("context");

  // AC-9 — skeleton ROWS in place of the list, not a spinner over it.
  if (isLoading) {
    return (
      <div style={s.loadingStack} aria-busy="true" aria-label={t("list.loading")}>
        {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <Skeleton key={i} height={SKELETON_ROW_HEIGHT} />
        ))}
      </div>
    );
  }

  // AC-10 — an error state WITH a retry control, in place of the list.
  if (isError) {
    return <ErrorState title={t("list.loadError")} body={errorBody} onRetry={onRetry} />;
  }

  const files = data?.files ?? [];

  // AC-8 — the empty state names all three roots. No CTA: there is nothing the
  // studio can do about it, the documents come from the repository.
  if (files.length === 0) {
    return (
      <EmptyState icon="FileText" title={t("empty.title")} body={t("empty.body")} />
    );
  }

  return (
    <>
      {/* AC-7 — the cap is reported above the list, never silently applied. */}
      {data && data.omitted > 0 && (
        <p style={s.overflowNote}>
          {t("list.showingOf", { shown: files.length, total: data.total })}
        </p>
      )}
      <div style={s.list} role="list" aria-label={t("list.label")}>
        {files.map((doc) => (
          <div role="listitem" key={doc.path}>
            <DocRow doc={doc} selected={doc.path === selected} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </>
  );
}
