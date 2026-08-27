/**
 * TokenTotal — NFR-9's contrast requirement for the FOOTER token total.
 *
 * NFR-9 (`specs/SPEC-01-project-context.md:732-736`) covers two things: the
 * source-kind chips, and "the footer token total, including its over-budget
 * colour", at a COMPUTED ratio >= 4.5:1 in both themes. The chips are measured in
 * `app/repos/[repoId]/context/_components/ProjectContextView/_components/DocRow/DocRow.test.tsx`;
 * the footer total was, until this file, resting on the claim in
 * `TokenTotal.tsx:10-11` that "`--crit` [...] meets 4.5:1 in both themes".
 *
 * Method is deliberately IDENTICAL to DocRow.test.tsx, so the two cannot drift
 * apart: jsdom resolves no custom property (`css: false` in `vitest.config.ts`,
 * so `getComputedStyle` hands back the literal `var(--crit)`), therefore the
 * ratio is computed with real WCAG 2.x relative-luminance maths over the ACTUAL
 * token values copied out of `src/vendor/ui/styles.css`. If a token there
 * changes, the tables below must change with it; that is the known cost of the
 * approach and the reason every value carries its source.
 *
 * The bridge from the tables to the implementation is the first assertion in
 * each test: the rendered element's inline `color` is read off the DOM, so
 * swapping `var(--crit)` for a token this file has not measured fails here
 * rather than passing silently.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PROJECT_CONTEXT_TOKEN_BUDGET } from "./constants";
import { TokenTotal } from "./TokenTotal";

// ---- The tokens under test, copied from src/vendor/ui/styles.css -----------

/** `--crit` — the over-budget foreground (`TokenTotal.tsx:45`). */
const CRIT = { dark: "#ef4444", light: "#dc2626" } as const;

/** `--text-secondary` — the under-budget foreground (`TokenTotal.tsx:45`). */
const TEXT_SECONDARY = { dark: "#999999", light: "#595964" } as const;

/**
 * The surfaces the footer actually composites over. `TokenTotal` paints no
 * background of its own and neither does either footer that wraps it
 * (`ContextTab/styles.ts:61-69`, `SkillContextField/styles.ts:38-44`), so the
 * colour behind the text is the nearest painted ancestor on each of the two
 * screens that render it:
 *
 *  - agent Context tab   → `AppFrame` paints `--bg-primary` (`vendor/ui/shell/AppFrame.tsx:22`);
 *    nothing between it and the footer paints (`app/agents/[id]/page.tsx`, `ContextTab.tsx`).
 *  - skill editor modal  → the modal panel paints `--bg-elevated` (`vendor/ui/kit/Modal.tsx:33`).
 *
 * Both are opaque hex tokens, so there is no alpha to composite here — unlike
 * the chips, whose tints are translucent.
 */
const SURFACES = {
  "--bg-primary": { dark: "#0a0a0a", light: "#ffffff" },
  "--bg-elevated": { dark: "#1c1c1c", light: "#ffffff" },
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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

function renderTotal(tokens: number) {
  render(
    <TokenTotal
      tokens={tokens}
      pendingCount={0}
      format={(sum, budget) => `${sum} of ${budget} tokens`}
      overBudgetLabel="over the run budget"
      pendingFormat={(count) => `${count} pending`}
    />,
  );
  return screen.getByRole("status");
}

describe("TokenTotal contrast (NFR-9)", () => {
  it("meets 4.5:1 for the OVER-budget total on both surfaces, in both themes", () => {
    // The bridge: the over-budget total must really be painted in `--crit`, or
    // the token table below is measuring a colour the component no longer uses.
    const el = renderTotal(PROJECT_CONTEXT_TOKEN_BUDGET + 1);
    expect(el).toHaveTextContent("over the run budget");
    expect(el.style.color).toBe("var(--crit)");

    for (const [surface, values] of Object.entries(SURFACES)) {
      for (const theme of ["dark", "light"] as const) {
        const ratio = contrast(hexToRgb(CRIT[theme]), hexToRgb(values[theme]));
        expect(
          ratio,
          `--crit on ${surface} in the ${theme} theme measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("meets 4.5:1 for the UNDER-budget total on both surfaces, in both themes", () => {
    const el = renderTotal(PROJECT_CONTEXT_TOKEN_BUDGET);
    expect(el).not.toHaveTextContent("over the run budget");
    expect(el.style.color).toBe("var(--text-secondary)");

    for (const [surface, values] of Object.entries(SURFACES)) {
      for (const theme of ["dark", "light"] as const) {
        const ratio = contrast(hexToRgb(TEXT_SECONDARY[theme]), hexToRgb(values[theme]));
        expect(
          ratio,
          `--text-secondary on ${surface} in the ${theme} theme measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * The margin, pinned. `--crit` on `--bg-elevated` in the DARK theme is the
   * tightest of the eight pairs at 4.53:1 — it clears 4.5 by 0.03. Recording it
   * as an upper bound means a future darkening of `--crit` or lightening of
   * `--bg-elevated` shows up here as a named near-miss rather than as a generic
   * "below 4.5" failure with no history.
   */
  it("records that --crit on --bg-elevated (dark) is the tightest pair, at 4.53:1", () => {
    const ratio = contrast(hexToRgb(CRIT.dark), hexToRgb(SURFACES["--bg-elevated"].dark));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.6);
  });
});
