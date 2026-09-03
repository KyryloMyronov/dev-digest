/**
 * SPEC-04 AC-75 / NFR-8 / NFR-9 — the three series of the metric trend.
 *
 * WHY THESE THREE TOKENS. `--ok` and `--warn` are the obvious picks for a
 * green/amber/blue trio and both FAIL the 4.5:1 floor against `--bg-elevated`
 * in the LIGHT theme (3.77:1 and 3.19:1 — measured, see `MetricTrend.test.tsx`).
 * `--accent`, `--crit` and `--text-secondary` clear it in both themes, so those
 * are what the lines are painted with. The rejected pair is asserted in the
 * suite so the reason survives the next redesign.
 *
 * NFR-9 — colour is never the only channel. Each series also carries its own
 * dash pattern and its own text label in the accessibility tree.
 */
export interface SeriesDef {
  /** The key on a `MetricTrendPoint`. */
  key: "recall" | "precision" | "citationAccuracy";
  /** The i18n key under `eval.dashboard.legend`. */
  messageKey: "recall" | "precision" | "citation";
  /** A CSS custom property, kept as the literal string jsdom preserves. */
  token: string;
  /** NFR-9's second channel — readable in print and under any CVD. */
  dash: string;
}

export const SERIES: readonly SeriesDef[] = [
  { key: "recall", messageKey: "recall", token: "var(--accent)", dash: "none" },
  { key: "precision", messageKey: "precision", token: "var(--crit)", dash: "6 3" },
  {
    key: "citationAccuracy",
    messageKey: "citation",
    token: "var(--text-secondary)",
    dash: "1 3",
  },
];

/** Chart geometry. The plot is a fraction, 0..1, so no y-axis scale is needed. */
export const CHART = {
  width: 520,
  height: 160,
  padTop: 10,
  padBottom: 26,
  padLeft: 8,
  padRight: 8,
} as const;
