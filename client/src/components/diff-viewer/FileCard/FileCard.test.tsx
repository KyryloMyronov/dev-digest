/**
 * FileCard — SPEC-03's four additions to the shipped card, in isolation.
 *
 * Mounted with an explicit `NextIntlClientProvider` and NOTHING else: wrapping a
 * test in `RepoProvider` makes the shell fetch more, and one non-array stub
 * blanks the whole render (client insights.md 2026-08-11). Every query is by
 * ROLE and ACCESSIBLE NAME, never by test id or class — which is the only way
 * AC-53, AC-62 and AC-69 can fail against a broken implementation.
 *
 * AC-73's ratio is computed here from the token table in
 * `src/vendor/ui/styles.css` (real WCAG maths on the real values) and BOUND to
 * the component by asserting the token it actually paints — `css: false` in
 * `vitest.config.ts` means no `var(--x)` ever resolves, so without that bridge
 * the arithmetic would drift from the component silently.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, Severity } from "@/lib/types";
import shell from "../../../../messages/en/shell.json";
import type { DiffAnnotation } from "../annotations";
import type { DiffSummaryApi } from "../summary";
import { FileCard } from "./FileCard";

afterEach(cleanup);

const PATCH = ["@@ -1,1 +1,3 @@", " const a = 1;", "+const b = 2;", "+const c = 3;"].join("\n");

const FILE: PrFile = { path: "src/middleware/ratelimit.ts", additions: 2, deletions: 0, patch: PATCH };

const LABELS = {
  derive: "Summarise this file — spends one model call",
  deriving: "Summarising…",
  noPatch: "No patch to summarise for this file",
};

function summaryApi(over: Partial<DiffSummaryApi> = {}): DiffSummaryApi {
  return {
    onDerive: vi.fn(),
    prLevelPending: false,
    pending: new Set<string>(),
    loading: false,
    labels: LABELS,
    ...over,
  };
}

function renderCard(
  props: Partial<React.ComponentProps<typeof FileCard>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ shell }}>
      <FileCard file={FILE} {...props} />
    </NextIntlClientProvider>,
  );
}

const summaryAnnotation = (over: Partial<NonNullable<DiffAnnotation["summary"]>> = {}) => ({
  summary: {
    text: "New token-bucket limiter: reads bucketKey, INCRs it in Redis, returns 429 over the limit.",
    headSha: "abc1234",
    stale: false,
    staleLabel: "Older commit",
    ...over,
  },
});

/** The card's disclosure control — named by the PATH (AC-69/AC-62). */
const disclosure = () => screen.getByRole("button", { name: new RegExp(FILE.path) });

// ------------------------------------------------ AC-69 / AC-70 · disclosure

describe("the header disclosure control (AC-69, AC-70)", () => {
  it("AC-69 — is a button exposing aria-expanded, in BOTH states", async () => {
    renderCard();
    const control = disclosure();
    // The card auto-expands at this size, so it starts open.
    expect(control).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(control);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  it("AC-69 — the header ROW itself is not a control; the affordance is nested", () => {
    // D-3: the header already owns the finding-jump badge and now the derive
    // control, and a <button> may not contain interactive descendants.
    renderCard({ summary: summaryApi() });
    const control = disclosure();
    expect(control.tagName).toBe("BUTTON");
    // The derive control is a SIBLING of the disclosure button, not inside it.
    const derive = screen.getByRole("button", { name: LABELS.derive });
    expect(control.contains(derive)).toBe(false);
    expect(derive.closest("button")).toBe(derive);
  });

  it("AC-70 — Enter folds it", async () => {
    renderCard();
    disclosure().focus();
    await userEvent.keyboard("{Enter}");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
  });

  it("AC-70 — Space folds it, dispatched separately from Enter", async () => {
    // The two keys are asserted apart on purpose: a `role="button"` +
    // `onKeyDown` implementation is exactly where the Space case gets missed,
    // and a real <button> is what makes both free.
    renderCard();
    disclosure().focus();
    await userEvent.keyboard(" ");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
  });

  it("AC-62 — a 180-character monorepo path is the control's untruncated accessible name", () => {
    const longPath = `packages/${"deeply-nested-workspace/".repeat(7)}src/handlers/ratelimit.ts`;
    expect(longPath.length).toBeGreaterThan(180);
    renderCard({ file: { ...FILE, path: longPath } });
    // Through the accessibility tree, NOT through `title`: `aria-label` beats
    // `title` for naming, so asserting the attribute could not fail on a broken
    // name (client insights.md 2026-08-28).
    //
    // The name legitimately carries the path PLUS the `+2 −0` stat, which is
    // inside the same button — "expose the untruncated value" is satisfied by a
    // name that CONTAINS it. Anchored at the start, so an `aria-label` that
    // REPLACED the path (the SPEC-02 defect shape) still fails.
    const control = screen.getByRole("button", { name: new RegExp(escapeRe(longPath)) });
    expect(control).toHaveAccessibleName(new RegExp(`^${escapeRe(longPath)}`));
  });
});

// ------------------------------------------- AC-49 / AC-50 / AC-58 · summary

describe("the summary line (AC-49, AC-50, AC-58, AC-61, AC-62)", () => {
  it("AC-49 — renders the summary ABOVE the first hunk row", () => {
    const { container } = renderCard({ annotation: summaryAnnotation() });
    const text = screen.getByText(/token-bucket limiter/);
    const hunk = screen.getByText("@@ -1,1 +1,3 @@");
    // Document order: the summary precedes the hunks it describes.
    expect(text.compareDocumentPosition(hunk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain("const b = 2;");
  });

  it("AC-50 — the summary is a property of the FILE, so nothing about it is view-specific", () => {
    // `DiffViewer` is the single component the smart groups and the flat list
    // both render, and the summary rides on the annotation — this asserts the
    // card needs no view flag to show it.
    renderCard({ annotation: summaryAnnotation() });
    expect(screen.getByText(/token-bucket limiter/)).toBeInTheDocument();
  });

  it("AC-58 — a stale summary is BADGED and its text is kept", () => {
    renderCard({ annotation: summaryAnnotation({ stale: true, headSha: "old1234" }) });
    expect(screen.getByText("Older commit")).toBeInTheDocument();
    expect(screen.getByText(/token-bucket limiter/)).toBeInTheDocument();
  });

  it("AC-58 — a fresh summary carries no staleness badge", () => {
    renderCard({ annotation: summaryAnnotation() });
    expect(screen.queryByText("Older commit")).not.toBeInTheDocument();
  });

  it("AC-61 — markup and a javascript: URL render as LITERAL TEXT, with no anchor", () => {
    const hostile = '<b>bold</b> <script>alert(1)</script> javascript:alert(1)';
    const { container } = renderCard({ annotation: summaryAnnotation({ text: hostile }) });
    expect(screen.getByText(hostile)).toBeInTheDocument();
    // The tags never became elements…
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // …and the URL never became a link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("AC-61 — RTL text and emoji pass through unchanged", () => {
    const text = "يضيف محدد المعدل 🚦 to the public routes";
    renderCard({ annotation: summaryAnnotation({ text }) });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("AC-62 — a visually truncated summary keeps the raw value as its accessible name", () => {
    const long = `Adds ${"a very specific detail ".repeat(20)}to the limiter.`;
    renderCard({ annotation: summaryAnnotation({ text: long }) });
    expect(screen.getByText(long)).toHaveAccessibleName(long);
  });
});

// ------------------------------- AC-51 / AC-52 / AC-53 / AC-63 · the control

describe("the per-file derivation control (AC-51, AC-52, AC-53, AC-63)", () => {
  it("AC-51 — offered when the file has no stored summary, and it requests THIS path", async () => {
    const api = summaryApi();
    renderCard({ summary: api });
    await userEvent.click(screen.getByRole("button", { name: LABELS.derive }));
    expect(api.onDerive).toHaveBeenCalledWith(FILE.path);
  });

  it("AC-51 — NOT offered once a summary exists (the three states stay distinct)", () => {
    renderCard({ summary: summaryApi(), annotation: summaryAnnotation() });
    expect(screen.queryByRole("button", { name: LABELS.derive })).toBeNull();
  });

  it("AC-53 — the accessible name states that activating it spends a model call", () => {
    renderCard({ summary: summaryApi() });
    const control = screen.getByRole("button", { name: LABELS.derive });
    expect(control).toHaveAccessibleName(LABELS.derive);
    expect(control.textContent).toBeTruthy();
    // The criterion is about the NAME, not the tooltip.
    expect(LABELS.derive).toMatch(/model call/);
  });

  it("AC-52 — disabled with no patch, and the reason is in the accessible name", () => {
    renderCard({ file: { ...FILE, patch: null }, summary: summaryApi() });
    const control = screen.getByRole("button", { name: LABELS.noPatch });
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleName(LABELS.noPatch);
  });

  it("AC-63 — every per-file control is disabled while a PR-level derivation is in flight", () => {
    renderCard({ summary: summaryApi({ prLevelPending: true }) });
    expect(screen.getByRole("button", { name: LABELS.derive })).toBeDisabled();
  });

  it("AC-57's observable — an in-flight control names itself, and returns to idle when it clears", () => {
    const { rerender } = renderCard({
      summary: summaryApi({ pending: new Set([FILE.path]) }),
    });
    expect(screen.getByRole("button", { name: LABELS.deriving })).toBeDisabled();

    rerender(
      <NextIntlClientProvider locale="en" messages={{ shell }}>
        <FileCard file={FILE} summary={summaryApi()} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: LABELS.derive })).toBeEnabled();
  });

  it("AC-54 — a skeleton renders in place of the summary line while the read is pending", () => {
    const { container } = renderCard({ summary: summaryApi({ loading: true }) });
    expect(container.querySelector("[data-summary-skeleton]")).toBeTruthy();
  });

  it("AC-54 — no skeleton once the summary itself has landed", () => {
    const { container } = renderCard({
      summary: summaryApi({ loading: true }),
      annotation: summaryAnnotation(),
    });
    expect(container.querySelector("[data-summary-skeleton]")).toBeNull();
    expect(screen.getByText(/token-bucket limiter/)).toBeInTheDocument();
  });

  it("no control at all when the tab passes no summary API", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: LABELS.derive })).toBeNull();
  });
});

// ------------------------ AC-65 / AC-66 / AC-67 / AC-72 · severity at the line

describe("severity at the line (AC-65, AC-66, AC-67, AC-72)", () => {
  const withSeverity = (severity: Severity): DiffAnnotation => ({
    findingLines: [2],
    severitiesByLine: new Map<number, Severity>([[2, severity]]),
  });

  it("AC-65 / AC-66 / AC-72 — the flagged row carries an icon AND the mixed-case label", () => {
    const { container } = renderCard({ annotation: withSeverity("CRITICAL") });
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    expect(row).toBeTruthy();
    // Mixed case, read off `vendor/ui/primitives/tokens.ts` — the all-caps look
    // is `textTransform`, a CSS effect that never reaches the DOM.
    expect(within(row).getByText("Critical")).toBeInTheDocument();
    expect(within(row).queryByText("CRITICAL")).toBeNull();
    // …and an icon beside it: colour is never the only cue.
    expect(row.querySelector("svg")).toBeTruthy();
  });

  it("AC-66 — each severity renders its own product-vocabulary label", () => {
    for (const [severity, label] of [
      ["CRITICAL", "Critical"],
      ["WARNING", "Warning"],
      ["SUGGESTION", "Suggestion"],
    ] as const) {
      const { container, unmount } = renderCard({ annotation: withSeverity(severity) });
      const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
      expect(within(row).getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("AC-65 — the row's left rule takes the severity's own colour", () => {
    const { container } = renderCard({ annotation: withSeverity("CRITICAL") });
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    expect(row.style.boxShadow).toBe("inset 3px 0 0 0 var(--crit)");
  });

  it("AC-67 — a marked line with NO resolvable severity keeps the shipped neutral highlight", () => {
    // Byte-identical to what shipped before SPEC-03. This is the branch a
    // client severity map narrower than the server's marked set falls into, so
    // it must stay reachable and unchanged.
    const { container } = renderCard({ annotation: { findingLines: [2] } });
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    expect(row.style.boxShadow).toBe("inset 3px 0 0 0 var(--warn)");
    expect(within(row).queryByText("Critical")).toBeNull();
  });

  it("AC-67 — a severity for a line the server did not mark changes nothing", () => {
    // The client map may legitimately be WIDER than the server's marked set
    // (the server truncates each finding's range, the client does not).
    const { container } = renderCard({
      annotation: { findingLines: [], severitiesByLine: new Map([[2, "CRITICAL" as Severity]]) },
    });
    expect(container.querySelector("[data-finding-line='true']")).toBeNull();
    expect(screen.queryByText("Critical")).toBeNull();
  });

  it("keeps data-new-line on every row — the jump path depends on it", () => {
    const { container } = renderCard({ annotation: withSeverity("WARNING") });
    expect(container.querySelector('[data-new-line="2"]')).toBeTruthy();
  });
});

// --------------------------------------------------------- AC-73 · contrast

describe("AC-73 — the summary line's contrast, computed", () => {
  // Copied from src/vendor/ui/styles.css. If a token there changes, this table
  // must change with it — the known cost of a `css: false` suite.
  const TOKENS = {
    dark: { text: "#999999", surface: "#1c1c1c" },
    light: { text: "#595964", surface: "#ffffff" },
  } as const;
  /** `--text-muted`, dark — the token this criterion exists to REJECT. */
  const MUTED_DARK = "#6e6e6e";

  const hexToRgb = (hex: string): [number, number, number] => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const luminance = ([r, g, b]: [number, number, number]) => {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (fg: string, bg: string) => {
    const a = luminance(hexToRgb(fg));
    const b = luminance(hexToRgb(bg));
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("paints the summary with --text-secondary (the bridge to the component)", () => {
    renderCard({ annotation: summaryAnnotation() });
    const text = screen.getByText(/token-bucket limiter/);
    // jsdom preserves an inline style verbatim, which is the only way to bind
    // the arithmetic below to what the component actually renders.
    expect(text.style.color).toBe("var(--text-secondary)");
  });

  it("clears 4.5:1 in BOTH themes, with an upper bound so drift breaks it", () => {
    const dark = contrast(TOKENS.dark.text, TOKENS.dark.surface);
    const light = contrast(TOKENS.light.text, TOKENS.light.surface);
    expect(dark).toBeGreaterThanOrEqual(4.5);
    expect(light).toBeGreaterThanOrEqual(4.5);
    // Pin the measured values: a bare `>= 4.5` would not notice a token moving.
    expect(dark).toBeCloseTo(5.98, 1);
    expect(light).toBeCloseTo(6.92, 1);
  });

  it("--text-muted would FAIL the same criterion — which is why it is not used", () => {
    // The shipped group hint paints with `--text-muted`; copying it here would
    // have shipped the failure this criterion exists to prevent (spec D-24).
    expect(contrast(MUTED_DARK, TOKENS.dark.surface)).toBeLessThan(4.5);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
