/**
 * DocRow — the source-kind chip, and NFR-9's contrast requirement.
 *
 * NFR-9 asks for a COMPUTED contrast ratio ≥ 4.5:1 in both themes. vitest's
 * jsdom cannot supply one: `css: false` in `vitest.config.ts` means the kit's
 * stylesheet is never loaded, so no CSS custom property resolves and
 * `getComputedStyle` returns the literal string `var(--accent-bg)`.
 *
 * So the ratio is computed here from the ACTUAL token values in
 * `src/vendor/ui/styles.css`, compositing each chip's translucent tint over that
 * theme's surface colour — real WCAG 2.x maths on the real values, for both
 * themes, rather than a resolved colour jsdom cannot give. If a token in
 * `styles.css` changes, the table below must change with it; that is the known
 * cost of this approach and the reason each value carries its source.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ContextDoc, ContextDocSource } from "@devdigest/shared";
import contextMessages from "../../../../../../../../../messages/en/context.json";
import { CHIP_FG, SOURCE_CHIP } from "../../constants";
import { DocRow } from "./DocRow";

// ---- The tokens under test, copied from src/vendor/ui/styles.css -----------

/** `--bg-surface` — what a chip's translucent tint composites over. */
const SURFACE = { dark: "#141414", light: "#fafafa" } as const;

/** `--text-primary` — the chip foreground (`CHIP_FG`). */
const TEXT_PRIMARY = { dark: "#ededed", light: "#18181b" } as const;

/** The three chip tints, as `[r, g, b, alpha]` straight out of styles.css. */
const TINTS: Record<ContextDocSource, { dark: [number, number, number, number]; light: [number, number, number, number] }> = {
  // --accent-bg
  specs: { dark: [59, 130, 246, 0.12], light: [37, 99, 235, 0.08] },
  // --ok-bg
  docs: { dark: [16, 185, 129, 0.12], light: [5, 150, 105, 0.08] },
  // --warn-bg
  insights: { dark: [245, 158, 11, 0.12], light: [217, 119, 6, 0.1] },
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function composite(
  [r, g, b, a]: [number, number, number, number],
  over: [number, number, number],
): [number, number, number] {
  return [
    a * r + (1 - a) * over[0],
    a * g + (1 - a) * over[1],
    a * b + (1 - a) * over[2],
  ];
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function doc(source: ContextDocSource): ContextDoc {
  return { path: `${source}/a.md`, source, tokens: 10, attached_agents: 0, size: 100 };
}

function renderRow(source: ContextDocSource) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ context: contextMessages }}>
      <DocRow doc={doc(source)} selected={false} onSelect={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

describe("DocRow source chips", () => {
  it.each(["specs", "docs", "insights"] as const)(
    "labels a %s document with its own icon and name",
    (source) => {
      renderRow(source);
      // The label is text, not colour alone — WCAG 1.4.1 as well as 1.4.3.
      expect(screen.getByText(source)).toBeInTheDocument();
      expect(SOURCE_CHIP[source].icon).toBeTruthy();
    },
  );

  it("gives the three sources three distinct icons", () => {
    const icons = Object.values(SOURCE_CHIP).map((c) => c.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // NFR-9 — the computed ratio, both themes.
  it.each(["specs", "docs", "insights"] as const)(
    "meets 4.5:1 contrast for the %s chip in both themes (NFR-9)",
    (source) => {
      // The implementation must actually be using --text-primary; if a future
      // edit swaps in a per-source colour, this table stops describing it.
      expect(CHIP_FG).toBe("var(--text-primary)");

      for (const theme of ["dark", "light"] as const) {
        const bg = composite(TINTS[source][theme], hexToRgb(SURFACE[theme]));
        const ratio = contrast(hexToRgb(TEXT_PRIMARY[theme]), bg);
        expect(
          ratio,
          `${source} chip in the ${theme} theme measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  /**
   * The rejected alternative, asserted so the reason survives: a per-source
   * FOREGROUND (`--ok` on `--ok-bg`) is the obvious design and it FAILS in the
   * light theme. Pinning it here is why `CHIP_FG` is `--text-primary`.
   */
  it("records why a per-source foreground was rejected (--ok on --ok-bg fails light)", () => {
    const okLight = hexToRgb("#059669"); // --ok, light theme
    const bgLight = composite(TINTS.docs.light, hexToRgb(SURFACE.light));
    expect(contrast(okLight, bgLight)).toBeLessThan(4.5);
  });
});
