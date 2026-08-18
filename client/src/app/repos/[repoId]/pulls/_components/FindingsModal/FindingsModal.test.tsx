/**
 * FindingsModal — the per-severity findings popup opened from a PR row counter.
 *
 * The load-bearing behaviour is the severity filter: the modal is opened from
 * ONE counter, so it must show that severity's findings and nothing else, even
 * though the query it reads returns every finding of every run on the PR.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, PrMeta, ReviewRecord } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/prReview.json";

const reviewsQuery = vi.fn();
vi.mock("@/lib/hooks/reviews", () => ({
  usePrReviews: () => reviewsQuery(),
}));
vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({ activeRepo: { full_name: "acme/payments-api" } }),
}));

import { FindingsModal } from "./FindingsModal";

afterEach(() => {
  cleanup();
  reviewsQuery.mockReset();
});

function finding(o: Partial<FindingRecord>): FindingRecord {
  return {
    id: "f1",
    severity: "CRITICAL",
    category: "security",
    title: "Hardcoded Stripe secret key in commit",
    file: "src/config.ts",
    start_line: 12,
    end_line: 12,
    rationale: "Line 12 contains a literal `sk_live_` Stripe secret key.",
    suggestion: null,
    confidence: 0.98,
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
    ...o,
  };
}

const PR: PrMeta = {
  id: "pr-1",
  number: 482,
  title: "Add rate limiting to public API endpoints",
  author: "marisa.koch",
  branch: "feat/ratelimit",
  base: "main",
  head_sha: "a1b2c3d",
  additions: 247,
  deletions: 38,
  files_count: 9,
  status: "needs_review",
  opened_at: null,
  updated_at: null,
  score: 61,
  cost_usd: null,
  findings: { CRITICAL: 1, WARNING: 1, SUGGESTION: 0 },
};

/** A review carrying `findings`; only that field is read by the modal. */
function review(findings: FindingRecord[]): ReviewRecord {
  return {
    id: "r1",
    pr_id: "pr-1",
    agent_id: null,
    run_id: null,
    agent_name: null,
    kind: "review",
    verdict: "request_changes",
    summary: null,
    score: 61,
    model: "seed",
    grounding: null,
    created_at: "2026-06-11T18:00:00.000Z",
    findings,
  };
}

function renderModal(severity: "CRITICAL" | "WARNING" | "SUGGESTION", onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <FindingsModal pr={PR} severity={severity} onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return { onClose };
}

describe("FindingsModal", () => {
  it("shows only the findings of the counter's severity", () => {
    reviewsQuery.mockReturnValue({
      data: [
        review([
          finding({ id: "f1", severity: "CRITICAL" }),
          finding({ id: "f2", severity: "WARNING", title: "N+1 query in user list endpoint" }),
        ]),
      ],
      isLoading: false,
      isError: false,
    });
    renderModal("CRITICAL");

    expect(screen.getByText("Critical findings")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded Stripe secret key in commit")).toBeInTheDocument();
    expect(screen.queryByText("N+1 query in user list endpoint")).not.toBeInTheDocument();
    expect(screen.getByText("1 finding")).toBeInTheDocument();
  });

  it("counts across every run on the PR, not just the newest", () => {
    reviewsQuery.mockReturnValue({
      data: [
        review([finding({ id: "f1", title: "From the newest run" })]),
        review([finding({ id: "f2", title: "From an older run" })]),
      ],
      isLoading: false,
      isError: false,
    });
    renderModal("CRITICAL");

    expect(screen.getByText("2 findings")).toBeInTheDocument();
    expect(screen.getByText("From the newest run")).toBeInTheDocument();
    expect(screen.getByText("From an older run")).toBeInTheDocument();
  });

  it("links a finding's file to the PR head sha on github", () => {
    reviewsQuery.mockReturnValue({
      data: [review([finding({ start_line: 45, end_line: 52 })])],
      isLoading: false,
      isError: false,
    });
    renderModal("CRITICAL");

    expect(screen.getByText("src/config.ts:45-52").closest("a")).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/a1b2c3d/src/config.ts#L45-L52",
    );
  });

  it("falls back to an empty state when the severity has no findings", () => {
    reviewsQuery.mockReturnValue({
      data: [review([finding({ severity: "CRITICAL" })])],
      isLoading: false,
      isError: false,
    });
    renderModal("SUGGESTION");

    expect(screen.getByText("No findings")).toBeInTheDocument();
    expect(
      screen.getByText("This pull request has no suggestion findings."),
    ).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    reviewsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });
    const { onClose } = renderModal("CRITICAL");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});