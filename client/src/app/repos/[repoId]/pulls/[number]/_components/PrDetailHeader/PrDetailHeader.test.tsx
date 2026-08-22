/**
 * PrDetailHeader — the severity counters in the meta row.
 *
 * What matters here is the wiring, not the counter behaviour itself (that is
 * pinned in FindingsCounters.test.tsx): the header must render all three
 * counters even when nothing was found, and a click on a non-zero counter must
 * reach the page's onOpenFindings with the right severity — the page owns the
 * modal, the header only reports the click.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrDetail, PrFindingCounts } from "@/lib/types";
import messages from "../../../../../../../../messages/en/prReview.json";
import { PrDetailHeader } from "./PrDetailHeader";

afterEach(cleanup);

const PR: PrDetail = {
  id: "pr-1",
  number: 482,
  title: "Add rate limiting to public API endpoints",
  author: "marisa.koch",
  branch: "feat/rate-limit-public",
  base: "main",
  head_sha: "abc1234",
  additions: 247,
  deletions: 38,
  files_count: 9,
  status: "needs_review",
  files: [],
  commits: [],
};

function renderHeader(findingCounts: PrFindingCounts | null, onOpenFindings = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <PrDetailHeader
        pr={PR}
        // null skips RunReviewDropdown, which would need a QueryClient.
        prId={null}
        tab="overview"
        findingsCount={0}
        findingCounts={findingCounts}
        githubUrl={null}
        onSetTab={() => {}}
        onOpenFindings={onOpenFindings}
        onRunStart={() => {}}
        onRunsStarted={() => {}}
      />
    </NextIntlClientProvider>,
  );
  return { onOpenFindings };
}

describe("PrDetailHeader findings counters", () => {
  it("opens the clicked severity through the page callback", () => {
    const { onOpenFindings } = renderHeader({ CRITICAL: 2, WARNING: 1, SUGGESTION: 0 });
    fireEvent.click(screen.getByLabelText("Show 2 Critical findings"));
    expect(onOpenFindings).toHaveBeenCalledWith("CRITICAL");
  });

  it("shows all three counters even when the PR has no findings at all", () => {
    renderHeader({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
    expect(screen.getByTitle("No Critical findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Warning findings")).toBeInTheDocument();
    expect(screen.getByTitle("No Suggestion findings")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(3);
  });

  it("renders all-zero counters while counts are still unknown", () => {
    renderHeader(null);
    expect(screen.getAllByText("0")).toHaveLength(3);
  });
});
