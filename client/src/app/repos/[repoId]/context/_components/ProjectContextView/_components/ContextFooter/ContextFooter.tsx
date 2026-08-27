/* ContextFooter — AC-16's footer: the discovered document count and when the
   token scan last ran.

   Deliberately NOT a chunk count: `code_chunks` is unwritten, chunking is a
   Non-goal, and `container.embedder()` throws when embeddings are off — a
   chunk figure here would be either always zero or an error path. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";

import { s } from "../../styles";

export function ContextFooter({
  total,
  scannedAt,
}: {
  total: number;
  /** ISO timestamp of the last token scan, or null when it has never run. */
  scannedAt: string | null;
}) {
  const t = useTranslations("context");
  return (
    <div style={s.footer}>
      <span>{t("footer.documents", { count: total })}</span>
      <span aria-hidden="true">·</span>
      {/* `null` gets its own sentence rather than an empty slot — "never" is a
          fact about the repository, not a missing value. */}
      <span>
        {scannedAt === null
          ? t("footer.neverScanned")
          : t("footer.scannedAt", { at: new Date(scannedAt).toLocaleString() })}
      </span>
    </div>
  );
}
