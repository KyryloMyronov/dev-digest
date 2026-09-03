/**
 * SPEC-04 AC-75 / NFR-8 / NFR-9 — the metric trend.
 *
 * The contrast half uses the `css: false` bridge (`client/insights.md`
 * 2026-08-27): the ratio is computed from a COPY of the token table, and bound
 * to the component by asserting the token it actually paints — jsdom preserves
 * `stroke="var(--accent)"` verbatim. Two costs, stated: the table below is a
 * copy of `styles.css`, and the surface is a static read of the call sites.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import evalMessages from "../../../../../messages/en/eval.json";
import { MetricTrend, type MetricTrendPoint } from "./MetricTrend";
import { SERIES } from "./constants";

/** The chart surface, from `styles.css` — `--bg-elevated` in both themes. */
const SURFACE = { dark: "#1c1c1c", light: "#ffffff" } as const;

/** A copy of the token table. Keyed by the literal the component paints. */
const TOKENS: Record<string, { dark: string; light: string }> = {
  "var(--accent)": { dark: "#3b82f6", light: "#2563eb" },
  "var(--crit)": { dark: "#ef4444", light: "#dc2626" },
  "var(--text-secondary)": { dark: "#999999", light: "#595964" },
  // The rejected pair, kept so the reason survives.
  "var(--ok)": { dark: "#10b981", light: "#059669" },
  "var(--warn)": { dark: "#f59e0b", light: "#d97706" },
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: string, bg: string): number {
  const a = luminance(hexToRgb(fg));
  const b = luminance(hexToRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const P = (r: number | null, p: number | null, c: number | null): MetricTrendPoint => ({
  recall: r,
  precision: p,
  citationAccuracy: c,
});

function renderTrend(points: MetricTrendPoint[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <MetricTrend points={points} />
    </NextIntlClientProvider>,
  );
}

describe("MetricTrend — rendering", () => {
  it("draws one SVG path per series", () => {
    const { container } = renderTrend([P(1, 0.9, 0.8), P(0.8, 0.7, 0.6), P(0.9, 0.95, 0.7)]);
    const paths = container.querySelectorAll("path[data-series]");
    expect(paths).toHaveLength(3);
    for (const p of Array.from(paths)) {
      expect(p.getAttribute("d")!.length).toBeGreaterThan(0);
    }
  });

  it("renders an empty state rather than an empty chart with no batches", () => {
    renderTrend([]);
    expect(screen.getByText(/trend appears after the first run/i)).toBeInTheDocument();
  });

  it("breaks the line at a null instead of joining across it", () => {
    // A null metric is "this batch scored nothing", not zero: joining would draw
    // a slope nobody measured.
    const { container } = renderTrend([P(1, 1, 1), P(null, 1, 1), P(0.5, 1, 1)]);
    const recall = container.querySelector('path[data-series="recall"]')!;
    // Two separate M commands = two segments, not one continuous line.
    expect(recall.getAttribute("d")!.match(/M/g)).toHaveLength(2);
  });

  it("places a single batch in the middle rather than dividing by zero", () => {
    const { container } = renderTrend([P(1, 1, 1)]);
    const d = container.querySelector('path[data-series="recall"]')!.getAttribute("d")!;
    expect(d).not.toContain("NaN");
  });
});

describe("AC-75 — the x-axis is the batch ORDINAL, exposed as text", () => {
  it("labels every batch by its ordinal position in the accessibility tree", () => {
    renderTrend([P(1, 1, 1), P(0.8, 0.8, 0.8), P(0.6, 0.6, 0.6)]);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Batch 1 of 3" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Batch 2 of 3" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Batch 3 of 3" })).toBeInTheDocument();
  });

  it("carries no date anywhere — the axis cannot be a time axis", () => {
    const { container } = renderTrend([P(1, 1, 1), P(0.8, 0.8, 0.8)]);
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("renders a null metric as a placeholder, never as 0%", () => {
    renderTrend([P(null, 1, 1)]);
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("NFR-9 — identity without colour", () => {
  it("names every series in text", () => {
    renderTrend([P(1, 1, 1)]);
    for (const label of ["Recall", "Precision", "Citation"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("gives every series its own dash pattern", () => {
    const dashes = SERIES.map((x) => x.dash);
    expect(new Set(dashes).size).toBe(dashes.length);
  });

  it("paints the dash pattern the constants declare", () => {
    const { container } = renderTrend([P(1, 1, 1), P(0.5, 0.5, 0.5)]);
    for (const series of SERIES) {
      const path = container.querySelector(`path[data-series="${series.key}"]`)!;
      expect(path.getAttribute("stroke-dasharray")).toBe(series.dash);
    }
  });
});

describe("NFR-8 — every series colour clears 4.5:1 in both themes", () => {
  it("paints the tokens the contrast table describes", () => {
    const { container } = renderTrend([P(1, 1, 1), P(0.5, 0.5, 0.5)]);
    for (const series of SERIES) {
      const path = container.querySelector(`path[data-series="${series.key}"]`)!;
      // Binds the table below to what is actually painted — without this the
      // ratios would be arithmetic about nothing.
      expect(path.getAttribute("stroke")).toBe(series.token);
      expect(TOKENS[series.token]).toBeDefined();
    }
  });

  it.each(SERIES.map((x) => x.key))("%s clears 4.5:1 on both surfaces", (key) => {
    const series = SERIES.find((x) => x.key === key)!;
    for (const theme of ["dark", "light"] as const) {
      const ratio = contrast(TOKENS[series.token]![theme], SURFACE[theme]);
      expect(
        ratio,
        `${key} in the ${theme} theme measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("records why --ok and --warn were rejected (both fail 4.5:1 in light)", () => {
    // The obvious green/amber/blue trio. Pinning the failure here is why
    // `constants.ts` uses --accent / --crit / --text-secondary instead.
    expect(contrast(TOKENS["var(--ok)"]!.light, SURFACE.light)).toBeLessThan(4.5);
    expect(contrast(TOKENS["var(--warn)"]!.light, SURFACE.light)).toBeLessThan(4.5);
    const used = SERIES.map((x) => x.token);
    expect(used).not.toContain("var(--ok)");
    expect(used).not.toContain("var(--warn)");
  });
});
