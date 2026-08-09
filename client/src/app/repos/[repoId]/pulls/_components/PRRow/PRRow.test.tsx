/**
 * PRRow — the COST cell. The list has no way to tell "nothing has run yet" from
 * "the latest run's model isn't priced" (both arrive as a null `cost_usd`), so
 * unlike the timeline it renders a single neutral "—" for either.
 *
 * Plus the FINDINGS cell's one integration risk: the whole row navigates on
 * click, so a counter click has to reach `onOpenFindings` *instead of* the
 * router — not as well as it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrMeta } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/prReview.json";
import { PRRow } from "./PRRow";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

function pr(o: Partial<PrMeta>): PrMeta {
  return {
    id: "pr-1",
    number: 482,
    title: "Add rate limiting",
    author: "marisa.koch",
    branch: "feat/ratelimit",
    base: "main",
    head_sha: "a1b2c3d",
    additions: 126,
    deletions: 38,
    files_count: 9,
    status: "needs_review",
    opened_at: "2026-06-11T18:00:00.000Z",
    updated_at: "2026-06-11T18:44:34.000Z",
    score: 61,
    cost_usd: null,
    ...o,
  };
}

function renderRow(p: PrMeta, onOpenFindings = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <PRRow pr={p} repoId="repo-1" onOpenFindings={onOpenFindings} />
    </NextIntlClientProvider>,
  );
  return { onOpenFindings };
}

describe("PRRow — cost cell", () => {
  it("renders the latest settled run's cost", () => {
    renderRow(pr({ cost_usd: 0.42 }));
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });

  it("uses sub-cent precision instead of collapsing to $0.00", () => {
    renderRow(pr({ cost_usd: 0.0042 }));
    expect(screen.getByText("$0.0042")).toBeInTheDocument();
  });

  it("renders — for a PR with no cost, and never n/a at list altitude", () => {
    // score stays set: an unreviewed PR renders its own "—" in the score cell,
    // and this assertion is about the cost cell.
    renderRow(pr({ cost_usd: null, score: 61 }));
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("n/a")).not.toBeInTheDocument();
  });

  it("keeps a free model as $0.00, distinct from the — placeholder", () => {
    renderRow(pr({ cost_usd: 0 }));
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });
});

describe("PRRow — findings cell", () => {
  it("raises the clicked severity instead of navigating to the PR", () => {
    const { onOpenFindings } = renderRow(
      pr({ findings: { CRITICAL: 2, WARNING: 0, SUGGESTION: 1 } }),
    );
    fireEvent.click(screen.getByLabelText("Show 2 Critical findings"));
    expect(onOpenFindings).toHaveBeenCalledWith("CRITICAL");
    expect(push).not.toHaveBeenCalled();
  });

  it("still navigates when the row is clicked anywhere else", () => {
    renderRow(pr({ findings: { CRITICAL: 2, WARNING: 0, SUGGESTION: 1 } }));
    fireEvent.click(screen.getByText("Add rate limiting"));
    expect(push).toHaveBeenCalledWith("/repos/repo-1/pulls/482");
  });

  it("renders counters for a PR the wire sent no breakdown for", () => {
    renderRow(pr({}));
    expect(screen.getAllByText("0")).toHaveLength(3);
  });
});