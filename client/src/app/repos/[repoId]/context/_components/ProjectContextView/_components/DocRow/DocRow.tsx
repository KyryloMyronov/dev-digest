/* DocRow — one discovered document in the list.

   A real <button>, so it is reachable and operable by keyboard with no extra
   wiring (NFR-6) and carries the focus ring the kit's stylesheet puts on
   `:focus-visible` (NFR-7).

   AC-13 vs AC-14, the pair most likely to be got wrong: the accessible name is
   the FULL, unmodified path; the visible text may be head-truncated. Both come
   off the same row, so they are set in one place here and nowhere else. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { ContextDoc } from "@/lib/types";
import { CHIP_FG, SOURCE_CHIP } from "../../constants";
import { formatBytes, truncatePathHead } from "../../helpers";
import { row } from "../../styles";

export function DocRow({
  doc,
  selected,
  onSelect,
}: {
  doc: ContextDoc;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const t = useTranslations("context");
  const chip = SOURCE_CHIP[doc.source];
  const size = formatBytes(doc.size);

  return (
    <button
      type="button"
      // The RAW path — no transformation, so unicode / emoji / RTL survive.
      aria-label={doc.path}
      title={doc.path}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(doc.path)}
      style={row.root(selected)}
    >
      <Badge icon={chip.icon} color={CHIP_FG} bg={chip.bg}>
        {t(`source.${doc.source}`)}
      </Badge>
      {/* Visible text only. `aria-label` above already fixes the accessible
          name, so truncating here cannot affect it (ARIA name computation
          prefers aria-label over the element's contents). */}
      <span className="mono" style={row.path}>
        {truncatePathHead(doc.path)}
      </span>
      <span style={row.meta}>
        {/* AC-35's pending indicator: `null` tokens are not zero tokens. */}
        <span className="tnum">
          {doc.tokens === null ? t("row.tokensPending") : t("row.tokens", { count: doc.tokens })}
        </span>
        {size && <span className="tnum">{size}</span>}
      </span>
    </button>
  );
}
