/**
 * DiffTab — the Smart Diff rendering of the Files changed tab.
 *
 * The interesting behaviour is what the grouping does to the DOM a reviewer
 * sees: three labelled sections in reading order, boilerplate collapsed, the
 * lines a finding points at marked, a severity badge on the file that carries
 * it, and the split banner only for an over-large PR. The last test pins the
 * fallback: with no smart-diff payload the tab is still the flat viewer it was
 * before L03, because the grouping is an enhancement, not a dependency.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, ReviewRecord } from "@devdigest/shared";
import type { PrFile, SmartDiff } from "@/lib/types";
import prReview from "../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../messages/en/shell.json";

const smartDiff = vi.hoisted(() => ({ data: undefined as SmartDiff | undefined }));

vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: () => ({ data: [] }),
  useCreatePrComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks", () => ({ useSmartDiff: () => smartDiff }));

import { DiffTab } from "./DiffTab";
import { resetFolds } from "./foldStore";

// jsdom has no scrollIntoView; the reveal flow calls it on the target row.
const scrollSpy = vi.fn();
window.HTMLElement.prototype.scrollIntoView = scrollSpy;

afterEach(() => {
  cleanup();
  smartDiff.data = undefined;
  resetFolds();
  window.localStorage.clear();
  scrollSpy.mockClear();
});

const PATCH = ["@@ -1,1 +1,3 @@", " const a = 1;", "+const b = 2;", "+const c = 3;"].join("\n");

const FILES: PrFile[] = [
  { path: "src/a.ts", additions: 2, deletions: 0, patch: PATCH },
  { path: "server/package.json", additions: 1, deletions: 0, patch: PATCH },
  { path: "pnpm-lock.yaml", additions: 900, deletions: 0, patch: PATCH },
];

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "bug",
  title: "Off-by-one",
  file: "src/a.ts",
  start_line: 2,
  end_line: 2,
  rationale: "because",
  suggestion: null,
  confidence: 0.9,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

/** One persisted review of the PR, as `GET /pulls/:id/reviews` serves it. */
const review = (over: Partial<ReviewRecord>): ReviewRecord => ({
  id: "r1",
  pr_id: "pr1",
  agent_id: "agent-general",
  run_id: "run1",
  agent_name: "General",
  kind: "review",
  verdict: "comment",
  summary: "s",
  score: 61,
  model: "seed",
  created_at: "2026-08-18T12:00:00.000Z",
  findings: [FINDING],
  ...over,
});

const REVIEWS: ReviewRecord[] = [review({})];

const GROUPED: SmartDiff = {
  groups: [
    { role: "core", files: [{ path: "src/a.ts", additions: 2, deletions: 0, finding_lines: [2] }] },
    {
      role: "wiring",
      files: [{ path: "server/package.json", additions: 1, deletions: 0, finding_lines: [] }],
    },
    {
      role: "boilerplate",
      files: [{ path: "pnpm-lock.yaml", additions: 900, deletions: 0, finding_lines: [] }],
    },
  ],
  split_suggestion: { too_big: false, total_lines: 903, proposed_splits: [] },
};

function renderTab(
  reviews: ReviewRecord[] = REVIEWS,
  extra: Partial<React.ComponentProps<typeof DiffTab>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell }}>
      <DiffTab prId="pr1" filesCount={FILES.length} files={FILES} reviews={reviews} {...extra} />
    </NextIntlClientProvider>,
  );
}

describe("DiffTab · Smart Diff", () => {
  it("renders the three roles in reading order", () => {
    smartDiff.data = GROUPED;
    renderTab();
    const headers = screen.getAllByRole("button", { expanded: true });
    // The label appears on the group header AND as a tag on each (open) file
    // header, so a collapsed card still says which group it belongs to.
    expect(screen.getAllByText("Core")).toHaveLength(2);
    expect(screen.getAllByText("Wiring")).toHaveLength(2);
    expect(screen.getByText("Boilerplate")).toBeInTheDocument();
    // Core + wiring start open; boilerplate does not.
    expect(headers).toHaveLength(2);
    expect(screen.getByRole("button", { expanded: false })).toHaveTextContent("Boilerplate");
    expect(screen.getByText("Smart Diff · grouped by role")).toBeInTheDocument();
  });

  it("keeps a lock file out of sight until it is asked for", async () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.queryByText("pnpm-lock.yaml")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("pnpm-lock.yaml")).toBeInTheDocument();
  });

  it("marks the diff line a finding points at, and badges the file", () => {
    smartDiff.data = GROUPED;
    const { container } = renderTab();
    const marked = container.querySelectorAll("[data-finding-line='true']");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("const b = 2;");
    // Severity comes from the reviews the page already loaded, so the badge and
    // the Findings tab cannot disagree.
    // The kit renders the severity's own label ("Critical"), uppercased in CSS.
    expect(screen.getByText("Critical")).toBeInTheDocument();
  });

  it("marks nothing when the PR has no findings", () => {
    smartDiff.data = {
      ...GROUPED,
      groups: GROUPED.groups.map((g) => ({
        ...g,
        files: g.files.map((f) => ({ ...f, finding_lines: [] })),
      })),
    };
    const { container } = renderTab([]);
    expect(container.querySelectorAll("[data-finding-line='true']")).toHaveLength(0);
    expect(screen.queryByText("Critical")).not.toBeInTheDocument();
  });

  it("badges only each agent's CURRENT review, so a superseded pass adds nothing", () => {
    smartDiff.data = GROUPED;
    renderTab([
      // Same agent, re-reviewed: the newer pass found one thing, the old pass
      // found three. Counting both would badge the file 4 while the server
      // highlights only what the current pass flagged.
      review({ id: "r2", created_at: "2026-08-18T13:00:00.000Z" }),
      review({
        id: "r1",
        created_at: "2026-08-18T12:00:00.000Z",
        findings: [
          { ...FINDING, id: "old1" },
          { ...FINDING, id: "old2" },
          { ...FINDING, id: "old3" },
        ],
      }),
    ]);
    // The badge's own text is label + count — asserting on the header instead
    // would pass on the "+2 −0" diff stat and prove nothing.
    expect(screen.getByText("Critical").textContent).toBe("Critical1");
  });

  it("keeps every agent's current review when a run fans out", () => {
    smartDiff.data = GROUPED;
    renderTab([
      review({ id: "r2", agent_id: "agent-security", created_at: "2026-08-18T12:00:00.000Z" }),
      review({ id: "r1", agent_id: "agent-general", created_at: "2026-08-18T12:00:00.000Z" }),
    ]);
    // Two agents, same timestamp: both count — 2, not 1.
    expect(screen.getByText("Critical").textContent).toBe("Critical2");
  });

  it("suggests a split only for an over-large PR", () => {
    smartDiff.data = GROUPED;
    const { unmount } = renderTab();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    unmount();

    smartDiff.data = {
      ...GROUPED,
      split_suggestion: {
        too_big: true,
        total_lines: 903,
        proposed_splits: [
          { name: "server", files: ["server/package.json"] },
          { name: "src", files: ["src/a.ts"] },
        ],
      },
    };
    renderTab();
    expect(screen.getByRole("note")).toHaveTextContent("This PR is large (903 changed lines)");
    expect(screen.getByText("server")).toBeInTheDocument();
  });

  it("falls back to the flat viewer while the grouping is unavailable", () => {
    smartDiff.data = undefined;
    renderTab();
    expect(screen.queryByText("Core")).not.toBeInTheDocument();
    // No grouping → nothing to toggle between, so no mode switch either.
    expect(screen.queryByRole("button", { name: /Standard/ })).not.toBeInTheDocument();
    for (const f of FILES) expect(screen.getByText(f.path)).toBeInTheDocument();
  });
});

describe("DiffTab · view mode toggle", () => {
  it("defaults to Smart, and Standard flattens the list without losing the files", async () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.getByText("Smart Diff · grouped by role")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Standard/ }));
    // Flat mode: no group sections, no role tags — but every file is there,
    // including the lock file the boilerplate group was hiding.
    expect(screen.queryByText("Smart Diff · grouped by role")).not.toBeInTheDocument();
    expect(screen.queryByText("Core")).not.toBeInTheDocument();
    for (const f of FILES) expect(screen.getByText(f.path)).toBeInTheDocument();
  });

  it("persists the choice per PR and honours it on the next visit", async () => {
    smartDiff.data = GROUPED;
    const { unmount } = renderTab();
    await userEvent.click(screen.getByRole("button", { name: /Standard/ }));
    expect(window.localStorage.getItem("devdigest:diff-view:pr1")).toBe("standard");
    unmount();

    renderTab();
    expect(screen.queryByText("Smart Diff · grouped by role")).not.toBeInTheDocument();
    // A different PR is untouched by pr1's choice.
    expect(window.localStorage.getItem("devdigest:diff-view:pr2")).toBeNull();
  });
});

describe("DiffTab · findings badge", () => {
  it("shows an explicit zero rather than hiding", () => {
    smartDiff.data = GROUPED;
    renderTab([]);
    expect(screen.getByText("0 findings")).toBeInTheDocument();
  });

  it("counts each agent's current findings when there are some", () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.getByText("1 findings")).toBeInTheDocument();
  });

  it("renders loading and failure as their own states, never as a count", () => {
    smartDiff.data = GROUPED;
    const { unmount } = renderTab(undefined, { reviewsPending: true });
    expect(screen.getByText("findings…")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ findings/)).not.toBeInTheDocument();
    unmount();

    renderTab(undefined, { reviewsFailed: true });
    expect(screen.getByText("findings unavailable")).toBeInTheDocument();
  });
});

describe("DiffTab · file finding badge (click → jump to the line)", () => {
  it("scrolls to the finding line instead of folding the card", async () => {
    smartDiff.data = GROUPED;
    const { container } = renderTab();
    expect(container.querySelectorAll("[data-finding-line='true']")).toHaveLength(1);

    await userEvent.click(screen.getByTitle("Jump to the finding's line"));

    // The click must not bubble into the header's fold toggle — the card
    // stays open and its marked line stays rendered.
    expect(container.querySelectorAll("[data-finding-line='true']")).toHaveLength(1);
    // …and the row the finding anchors to (new-side line 2) is what scrolls.
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    const target = scrollSpy.mock.contexts.at(-1) as HTMLElement;
    expect(target.getAttribute("data-new-line")).toBe("2");
  });
});

describe("DiffTab · reveal (click a finding → jump to the code)", () => {
  it("expands the collapsed group and file hiding the target, then scrolls to the line", async () => {
    smartDiff.data = GROUPED;
    renderTab(REVIEWS, { reveal: { path: "pnpm-lock.yaml", line: 2, token: 1 } });
    // The boilerplate group and the lock file both start collapsed — the jump
    // must open the whole chain, not land on a folded card.
    expect(screen.getByText("pnpm-lock.yaml")).toBeInTheDocument();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });
});
