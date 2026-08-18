/**
 * FindingsCounters — the FINDINGS cell of a PR row.
 *
 * Three behaviours carry real weight: all three severities always render (a
 * zero is a fact worth reading, so the cell shape is stable down the column),
 * a zero is inert rather than a button onto an empty modal, and a counter click
 * must NOT bubble into the row's navigate handler — without the
 * stopPropagation, clicking a counter would route to the PR detail page and the
 * modal would never be seen.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFindingCounts } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/prReview.json";
import { FindingsCounters } from "./FindingsCounters";

afterEach(cleanup);

function renderCounters(counts: PrFindingCounts | null, onOpen = vi.fn()) {
  const rowClick = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {/* Mirrors PRRow: the cell lives inside a row that navigates on click. */}
      <div onClick={rowClick}>
        <FindingsCounters counts={counts} onOpen={onOpen} />
      </div>
    </NextIntlClientProvider>,
  );
  return { onOpen, rowClick };
}

describe("FindingsCounters", () => {
  it("renders one counter per severity that has findings", () => {
    renderCounters({ CRITICAL: 2, WARNING: 3, SUGGESTION: 1 });
    expect(screen.getByLabelText("Show 2 Critical findings")).toBeInTheDocument();
    expect(screen.getByLabelText("Show 3 Warning findings")).toBeInTheDocument();
    // Singular at 1 — the label is read aloud, so it is pluralised properly.
    expect(screen.getByLabelText("Show 1 Suggestion finding")).toBeInTheDocument();
  });

  it("still renders the severities that are at zero, but not as buttons", () => {
    renderCounters({ CRITICAL: 0, WARNING: 2, SUGGESTION: 0 });
    // Only the warning counter can be opened; the two zeros are inert.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByLabelText("Show 2 Warning findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Critical findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Suggestion findings")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(2);
  });

  it("shows all three counters — not a — — for a reviewed PR with nothing found", () => {
    renderCounters({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
    expect(screen.getAllByText("0")).toHaveLength(3);
    expect(screen.getByTitle("No Critical findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Warning findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Suggestion findings")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the counters even for a PR that has never been reviewed", () => {
    // No counts on the wire at all — the cell is still never empty, and never a
    // "—" (that placeholder belongs to the score cell).
    renderCounters(null);
    expect(screen.getAllByText("0")).toHaveLength(3);
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the clicked severity without triggering the row's navigation", () => {
    const { onOpen, rowClick } = renderCounters({ CRITICAL: 2, WARNING: 1, SUGGESTION: 0 });
    fireEvent.click(screen.getByLabelText("Show 2 Critical findings"));
    expect(onOpen).toHaveBeenCalledWith("CRITICAL");
    expect(rowClick).not.toHaveBeenCalled();
  });
});