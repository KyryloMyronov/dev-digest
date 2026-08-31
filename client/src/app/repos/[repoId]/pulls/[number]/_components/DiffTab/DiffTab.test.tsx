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
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, PrFileSummariesResponse, ReviewRecord } from "@devdigest/shared";
import type { PrFile, SmartDiff } from "@/lib/types";
import prReview from "../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../messages/en/shell.json";

const smartDiff = vi.hoisted(() => ({ data: undefined as SmartDiff | undefined }));

vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: () => ({ data: [] }),
  useCreatePrComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks", () => ({ useSmartDiff: () => smartDiff }));

/**
 * SPEC-03's summaries are NOT module-mocked: they go through the real
 * `usePrFileSummaries` against a stubbed `fetch`, which is the only way AC-56's
 * polling and AC-55's error state can fail against a broken implementation. A
 * module mock would assert the harness instead of the code.
 *
 * Stated for the record, because it bounds what this suite can prove: an RTL
 * suite stubbing `fetch` cannot see a SERVER-side join go wrong. That is why
 * step 14's integration tests are not redundant, and why SPEC-03's Non-goal of
 * an e2e flow leaves a STATED gap rather than an unnoticed one.
 */
const summaries = vi.hoisted(() => ({
  data: undefined as PrFileSummariesResponse | undefined,
  status: 200,
  gets: 0,
  posts: [] as unknown[],
}));

const fetchStub = vi.fn(async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  if (href.includes("/file-summaries")) {
    if (init?.method === "POST") {
      summaries.posts.push(init.body ? JSON.parse(String(init.body)) : null);
      return { ok: true, status: 202, json: async () => ({ status: "accepted", jobId: "j1" }) };
    }
    summaries.gets += 1;
    if (summaries.status !== 200) {
      return {
        ok: false,
        status: summaries.status,
        statusText: "Server Error",
        json: async () => ({ error: { code: "internal_error", message: "boom" } }),
      };
    }
    return { ok: true, status: 200, json: async () => summaries.data ?? EMPTY_SUMMARIES };
  }
  throw new Error(`unexpected fetch: ${href}`);
});
vi.stubGlobal("fetch", fetchStub);

const EMPTY_SUMMARIES: PrFileSummariesResponse = {
  summaries: [],
  omitted_files: [],
  selected: 0,
  total: 0,
};

const summaryRow = (over: Partial<PrFileSummariesResponse["summaries"][number]> = {}) => ({
  path: "src/a.ts",
  summary: "Adds a token-bucket limiter keyed on bucketKey.",
  head_sha: "head-1",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  tokens_in: 100,
  tokens_out: 20,
  cost_usd: 0.0031,
  created_at: "2026-08-29T00:00:00.000Z",
  ...over,
});

import { DERIVE_TIMEOUT_MS, FILE_SUMMARY_POLL_MS } from "@/lib/hooks/file-summary";
import { DiffTab } from "./DiffTab";
import { resetFolds } from "./foldStore";

// jsdom has no scrollIntoView; the reveal flow calls it on the target row.
const scrollSpy = vi.fn();
window.HTMLElement.prototype.scrollIntoView = scrollSpy;

afterEach(() => {
  cleanup();
  smartDiff.data = undefined;
  summaries.data = undefined;
  summaries.status = 200;
  summaries.gets = 0;
  summaries.posts = [];
  fetchStub.mockClear();
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{ prReview, shell }}>
        <DiffTab
          prId="pr1"
          filesCount={FILES.length}
          files={FILES}
          reviews={reviews}
          headSha="head-1"
          additions={903}
          deletions={12}
          {...extra}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The group header for a role, located the way a screen reader would find it. */
const groupHeader = (name: RegExp) => screen.getByRole("button", { name });
/** The file card's disclosure control (AC-69) — named by its path. */
const fileHeader = (path: string) => screen.getByRole("button", { name: new RegExp(path) });

describe("DiffTab · Smart Diff", () => {
  it("renders the three roles in reading order", () => {
    smartDiff.data = GROUPED;
    renderTab();
    // SPEC-03 RE-POINTED (was `getAllByRole("button", {expanded:true})` with a
    // count of 2). AC-69 gave every FILE-CARD header an `aria-expanded` too, so
    // that query now matches the group headers AND every open card — which is
    // the behaviour, not a break. The group state is asserted BY NAME instead;
    // the card count is its own assertion below.
    expect(groupHeader(/Core logic/)).toHaveAttribute("aria-expanded", "true");
    expect(groupHeader(/Wiring/)).toHaveAttribute("aria-expanded", "true");
    // The label appears on the group header AND as a tag on each (open) file
    // header, so a collapsed card still says which group it belongs to.
    // AC-44: `Core` became `Core logic`; `Wiring`/`Boilerplate` are unchanged.
    expect(screen.getAllByText("Core logic")).toHaveLength(2);
    expect(screen.getAllByText("Wiring")).toHaveLength(2);
    expect(screen.getByText("Boilerplate")).toBeInTheDocument();
    // Core + wiring start open; boilerplate does not.
    expect(groupHeader(/Boilerplate/)).toHaveAttribute("aria-expanded", "false");
    // AC-40 / AC-41 — the chrome that replaced `Smart Diff · grouped by role`.
    expect(screen.getByText("REVIEWER-ORDERED DIFF")).toBeInTheDocument();
    expect(screen.getByText("3 files · +903 −12")).toBeInTheDocument();
  });

  it("AC-69 — every file-card header is a control exposing its expanded state", () => {
    smartDiff.data = GROUPED;
    renderTab();
    // The behaviour the assertion above had to make room for: each rendered
    // card's header is a real button, open or shut.
    expect(fileHeader("src/a.ts")).toHaveAttribute("aria-expanded", "true");
    expect(fileHeader("server/package.json")).toHaveAttribute("aria-expanded", "true");
  });

  it("AC-44 — each group's hint is the accepted category copy", () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.getByText("The substance of the change — review closely")).toBeInTheDocument();
    expect(screen.getByText("Hooks the core into the app")).toBeInTheDocument();
    expect(screen.getByText("Generated / mechanical — skim")).toBeInTheDocument();
  });

  it("AC-48 — one sentence separates this ordering from the brief's review focus", () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.getByText(/every changed file, ordered for reading/i)).toBeInTheDocument();
  });

  it("AC-42 — the toggle reads Smart order then Original order, in that DOM order", () => {
    smartDiff.data = GROUPED;
    renderTab();
    const smart = screen.getByRole("button", { name: /Smart order/ });
    const original = screen.getByRole("button", { name: /Original order/ });
    expect(smart.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("AC-43 — no groups, no toggle (a control with nothing to toggle into is dead)", () => {
    smartDiff.data = undefined;
    renderTab();
    expect(screen.queryByRole("button", { name: /Smart order/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Original order/ })).not.toBeInTheDocument();
  });

  it("AC-45 — the Boilerplate group renders collapsed on first render", () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.queryByText("pnpm-lock.yaml")).not.toBeInTheDocument();
  });

  it("AC-46 — every hunk header in a patch gets its own row", () => {
    smartDiff.data = GROUPED;
    renderTab();
    // One `@@` header per file in FILES' shared patch; all three files render
    // once the lock file's group is opened, so assert the two visible ones.
    expect(screen.getAllByText("@@ -1,1 +1,3 @@").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a lock file out of sight until it is asked for", async () => {
    smartDiff.data = GROUPED;
    renderTab();
    expect(screen.queryByText("pnpm-lock.yaml")).not.toBeInTheDocument();
    // SPEC-03 RE-POINTED: `getByRole("button", {expanded:false})` is ambiguous
    // now that collapsed FILE cards match it too (AC-69). Locate the group
    // header by name instead.
    await userEvent.click(groupHeader(/Boilerplate/));
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
    //
    // SPEC-03 RE-POINTED: `getByText("Critical")` is now ambiguous — AC-65 puts
    // the same label ON THE LINE as well as in the header badge. That is the
    // feature; the assertion is scoped to the header, and the line's own label
    // is asserted separately below.
    expect(within(marked[0] as HTMLElement).getByText("Critical")).toBeInTheDocument();
    expect(screen.getAllByText("Critical").length).toBeGreaterThanOrEqual(2);
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
    // SPEC-03 RE-POINTED: the label now also appears at the line (AC-65), so
    // the badge is the one carrying a COUNT.
    const badge = screen.getAllByText("Critical").find((el) => el.textContent === "Critical1");
    expect(badge).toBeDefined();
  });

  it("keeps every agent's current review when a run fans out", () => {
    smartDiff.data = GROUPED;
    renderTab([
      review({ id: "r2", agent_id: "agent-security", created_at: "2026-08-18T12:00:00.000Z" }),
      review({ id: "r1", agent_id: "agent-general", created_at: "2026-08-18T12:00:00.000Z" }),
    ]);
    // Two agents, same timestamp: both count — 2, not 1.
    const badge = screen.getAllByText("Critical").find((el) => el.textContent === "Critical2");
    expect(badge).toBeDefined();
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
    expect(screen.queryByText("Core logic")).not.toBeInTheDocument();
    // No grouping → nothing to toggle between, so no mode switch either.
    expect(screen.queryByRole("button", { name: /Original order/ })).not.toBeInTheDocument();
    for (const f of FILES) expect(screen.getByText(f.path)).toBeInTheDocument();
  });
});

describe("DiffTab · file summaries (SPEC-03)", () => {
  const withSummary = (over: Partial<PrFileSummariesResponse> = {}): PrFileSummariesResponse => ({
    summaries: [summaryRow()],
    omitted_files: [],
    selected: 1,
    total: 1,
    ...over,
  });

  it("AC-49 / AC-50 — the summary renders in the smart view AND after switching to original order", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary();
    renderTab();
    expect(await screen.findByText(/token-bucket limiter/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Original order/ }));
    // A summary is a property of the FILE, not of the view.
    expect(screen.getByText(/token-bucket limiter/)).toBeInTheDocument();
  });

  it("AC-51 / AC-52 — a file with no summary offers the control; a patch-less file's is disabled", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ summaries: [], selected: 0, total: 2 });
    renderTab(REVIEWS, {
      files: [FILES[0]!, { ...FILES[1]!, patch: null }, FILES[2]!],
    });
    const controls = await screen.findAllByRole("button", { name: /spends one model call/ });
    expect(controls.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /No patch to summarise/ })).toBeDisabled();
  });

  it("AC-53 — the control's accessible name says it spends a model call", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ summaries: [], selected: 0, total: 1 });
    renderTab();
    const control = (await screen.findAllByRole("button", { name: /spends one model call/ }))[0]!;
    expect(control).toHaveAccessibleName("Summarise this file — spends one model call");
  });

  it("AC-54 — a skeleton stands in for each summary line while the read is pending", () => {
    smartDiff.data = GROUPED;
    const { container } = renderTab();
    // First render: the query has not resolved, so no summary exists yet.
    expect(container.querySelectorAll("[data-summary-skeleton]").length).toBeGreaterThan(0);
  });

  it("AC-55 — a failed read renders an error state with a working retry", async () => {
    smartDiff.data = GROUPED;
    summaries.status = 500;
    renderTab();
    expect(await screen.findByText(/couldn't be loaded/i)).toBeInTheDocument();

    const before = summaries.gets;
    summaries.status = 200;
    summaries.data = withSummary();
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(summaries.gets).toBeGreaterThan(before));
    expect(await screen.findByText(/token-bucket limiter/)).toBeInTheDocument();
  });

  it("AC-59 — the running total renders through the shared formatter, for all three cases", async () => {
    smartDiff.data = GROUPED;
    // A real amount, sub-cent → 4 dp.
    summaries.data = withSummary({ summaries: [summaryRow({ cost_usd: 0.0031 })] });
    const a = renderTab();
    expect(await screen.findByText(/Derivation cost \$0\.0031/)).toBeInTheDocument();
    a.unmount();

    // A genuinely free model → "$0.00", NOT the placeholder.
    summaries.data = withSummary({ summaries: [summaryRow({ cost_usd: 0 })] });
    const b = renderTab();
    expect(await screen.findByText(/Derivation cost \$0\.00$/)).toBeInTheDocument();
    b.unmount();

    // Unpriced → the explicit placeholder. `null` is never coalesced to 0.
    summaries.data = withSummary({ summaries: [summaryRow({ cost_usd: null })] });
    renderTab();
    expect(await screen.findByText("Derivation cost n/a")).toBeInTheDocument();
  });

  it("AC-60 — an omitted set renders the n-of-m line", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ omitted_files: ["src/b.ts", "src/c.ts"], selected: 1, total: 3 });
    renderTab();
    expect(await screen.findByText("1 of 3 files summarised")).toBeInTheDocument();
  });

  it("AC-60 — nothing omitted, no line", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary();
    renderTab();
    await screen.findByText(/token-bucket limiter/);
    expect(screen.queryByText(/files summarised/)).not.toBeInTheDocument();
  });

  it("AC-61 — a hostile summary renders as literal text with no anchor", async () => {
    smartDiff.data = GROUPED;
    const hostile = "<b>bold</b> javascript:alert(1)";
    summaries.data = withSummary({ summaries: [summaryRow({ summary: hostile })] });
    const { container } = renderTab();
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("AC-63 — every per-file control is disabled while a PR-level derivation is in flight", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ summaries: [], selected: 0, total: 2 });
    renderTab();
    const before = (await screen.findAllByRole("button", { name: /spends one model call/ }))[0]!;
    expect(before).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Summarise files" }));

    await waitFor(() => {
      const control = screen.getAllByRole("button", { name: /spends one model call/ })[0]!;
      expect(control).toBeDisabled();
    });
    // …and the POST that started it carried NO path — a PR-level derivation.
    expect(summaries.posts.at(-1)).toBeNull();
  });

  it("AC-64 — a per-file summary landing renders while the PR-level wait CONTINUES", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ summaries: [], selected: 0, total: 3 });
    renderTab();
    await screen.findAllByRole("button", { name: /spends one model call/ });

    await userEvent.click(screen.getByRole("button", { name: "Summarise files" }));
    await waitFor(() => expect(screen.getByText("Deriving file summaries…")).toBeInTheDocument());

    // One file lands. `selected` moves 0 → 1, which does NOT satisfy
    // `selected === total`, so the PR-level wait must continue.
    summaries.data = withSummary({ summaries: [summaryRow()], selected: 1, total: 3 });
    await waitFor(() => expect(screen.getByText(/token-bucket limiter/)).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByText("Deriving file summaries…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarising…" })).toBeDisabled();
  }, 10000);

  it("AC-71 — the status region announces each derivation state change", async () => {
    smartDiff.data = GROUPED;
    summaries.data = withSummary({ summaries: [], selected: 0, total: 1 });
    renderTab();
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("File summaries idle."));

    await userEvent.click(screen.getByRole("button", { name: "Summarise files" }));
    await waitFor(() => expect(status).toHaveTextContent("Deriving file summaries…"));

    summaries.data = withSummary();
    await waitFor(() => expect(status).toHaveTextContent("File summaries ready."), {
      timeout: 4000,
    });
  }, 10000);
});

describe("DiffTab · severity in the diff (SPEC-03)", () => {
  it("AC-47 / AC-65 / AC-72 — every severity rendering carries an icon AND a text label", () => {
    smartDiff.data = GROUPED;
    const { container } = renderTab();

    // 1. The FILE HEADER badge (shipped; asserted, not rebuilt).
    const jump = screen.getByTitle("Jump to the finding's line");
    expect(within(jump).getByText("Critical")).toBeInTheDocument();
    expect(jump.querySelector("svg")).toBeTruthy();

    // 2. The LINE mark (new).
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    expect(within(row).getByText("Critical")).toBeInTheDocument();
    expect(row.querySelector("svg")).toBeTruthy();

    // Colour is never the only cue anywhere in the tab: every severity surface
    // carries the word itself (the header badge appends its count, hence
    // `toContain` rather than an equality).
    const surfaces = screen.getAllByText("Critical");
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    for (const el of surfaces) expect(el.textContent).toContain("Critical");
  });

  it("AC-68 — the line marks and the header badge come from the SAME review set", () => {
    smartDiff.data = GROUPED;
    const { container } = renderTab([
      // A superseded pass by the same agent, with a LOUDER severity. If the
      // line marks were computed from a different set than the badge, this is
      // where they would disagree.
      review({
        id: "r-old",
        created_at: "2026-08-18T11:00:00.000Z",
        findings: [{ ...FINDING, id: "old", severity: "CRITICAL" }],
      }),
      review({
        id: "r-new",
        created_at: "2026-08-18T13:00:00.000Z",
        findings: [{ ...FINDING, id: "new", severity: "SUGGESTION" }],
      }),
    ]);
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    // Both surfaces show the CURRENT pass's severity, and neither shows the
    // superseded CRITICAL.
    expect(within(row).getByText("Suggestion")).toBeInTheDocument();
    expect(screen.queryByText("Critical")).not.toBeInTheDocument();
    expect(screen.getAllByText("Suggestion").length).toBeGreaterThanOrEqual(2);
  });

  it("AC-67 — a marked line whose severity does not resolve keeps the neutral highlight", () => {
    smartDiff.data = GROUPED;
    // Findings exist for the file, but the reviews the page holds are empty —
    // the server marked the line, the client can resolve no severity for it.
    const { container } = renderTab([]);
    const row = container.querySelector("[data-finding-line='true']") as HTMLElement;
    expect(row.style.boxShadow).toBe("inset 3px 0 0 0 var(--warn)");
    expect(within(row).queryByText("Critical")).toBeNull();
  });
});

describe("DiffTab · view mode toggle", () => {
  it("defaults to Smart, and Standard flattens the list without losing the files", async () => {
    smartDiff.data = GROUPED;
    renderTab();
    // SPEC-03 RE-POINTED: `Smart Diff · grouped by role` is gone (AC-40/AC-41),
    // so the smart view is identified by its role tags instead.
    expect(screen.getAllByText("Core logic").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: /Original order/ }));
    // Flat mode: no group sections, no role tags — but every file is there,
    // including the lock file the boilerplate group was hiding.
    expect(screen.queryByText("Core logic")).not.toBeInTheDocument();
    for (const f of FILES) expect(screen.getByText(f.path)).toBeInTheDocument();
  });

  it("persists the choice per PR and honours it on the next visit", async () => {
    smartDiff.data = GROUPED;
    const { unmount } = renderTab();
    await userEvent.click(screen.getByRole("button", { name: /Original order/ }));
    expect(window.localStorage.getItem("devdigest:diff-view:pr1")).toBe("standard");
    unmount();

    renderTab();
    expect(screen.queryByText("Core logic")).not.toBeInTheDocument();
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

  // SPEC-02 AC-50 / D-7 — REGRESSION ASSERTIONS for a deliberate change to
  // SHIPPED behaviour: a reveal now moves KEYBOARD FOCUS to the revealed file
  // card, for every caller. Written here, in the existing suite, rather than
  // only in BriefCard.test.tsx, so the change is visible in a diff instead of
  // being discovered by a user.
  it("moves keyboard focus to the revealed file card", async () => {
    smartDiff.data = GROUPED;
    renderTab(REVIEWS, { reveal: { path: "src/a.ts", line: 2, token: 1 } });

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(document.body);
      // The card root is programmatically focusable but never a tab stop.
      expect(focused.getAttribute("tabindex")).toBe("-1");
      expect(focused.textContent).toContain("src/a.ts");
    });
  });

  it("focuses with preventScroll, so the explicit scrollIntoView still owns the scroll position", async () => {
    smartDiff.data = GROUPED;
    const focusSpy = vi.spyOn(window.HTMLElement.prototype, "focus");
    try {
      renderTab(REVIEWS, { reveal: { path: "src/a.ts", line: 2, token: 1 } });
      await waitFor(() => expect(focusSpy).toHaveBeenCalled());
      // Without `preventScroll` the browser's own focus scroll fights the
      // smooth `scrollIntoView({ block: "center" })` fired immediately before.
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      // The scroll target is still the LINE, not the focused card.
      const target = scrollSpy.mock.contexts.at(-1) as HTMLElement;
      expect(target.getAttribute("data-new-line")).toBe("2");
    } finally {
      focusSpy.mockRestore();
    }
  });
});

/**
 * NFR-6's two numbers, on FAKE timers.
 *
 * `useFakeTimers` lives in beforeEach/afterEach rather than a try/finally: a
 * test that times out never reaches its `finally`, and leaving timers mocked
 * poisons every test after it in the file — which is how a green suite starts
 * lying about something else entirely.
 *
 * `fireEvent`, not `userEvent`: userEvent's own timer wiring fights the mocked
 * clock, and the click here is a plain one with nothing to simulate.
 */
describe("DiffTab · the bounded wait (SPEC-03 AC-56, AC-57, NFR-6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const pending = (): PrFileSummariesResponse => ({
    summaries: [],
    omitted_files: ["src/a.ts"],
    selected: 0,
    total: 3,
  });
  const landed = (): PrFileSummariesResponse => ({
    summaries: [summaryRow()],
    omitted_files: [],
    selected: 3,
    total: 3,
  });
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("AC-56 / NFR-6 — re-reads every 2 000 ms while a derivation is awaited, and STOPS once it lands", async () => {
    smartDiff.data = GROUPED;
    summaries.data = pending();
    renderTab();
    await tick(0);
    const afterMount = summaries.gets;
    expect(afterMount).toBeGreaterThan(0);

    // Nothing awaited ⇒ NO polling. This half is what makes the next half mean
    // something: without it the test would pass against an unconditional poll.
    await tick(FILE_SUMMARY_POLL_MS * 3);
    expect(summaries.gets).toBe(afterMount);

    fireEvent.click(screen.getByRole("button", { name: "Summarise files" }));
    await tick(FILE_SUMMARY_POLL_MS + 50);
    const afterOne = summaries.gets;
    expect(afterOne).toBeGreaterThan(afterMount);

    await tick(FILE_SUMMARY_POLL_MS + 50);
    expect(summaries.gets).toBeGreaterThan(afterOne);

    // The SERVER's own state is the stop condition (`selected === total`), so a
    // derivation completed in another tab ends this wait too.
    summaries.data = landed();
    await tick(FILE_SUMMARY_POLL_MS + 50);
    const afterLanding = summaries.gets;
    await tick(FILE_SUMMARY_POLL_MS * 4);
    expect(summaries.gets).toBe(afterLanding);
  });

  it("AC-57 — a derivation that never lands returns the control to idle after 90 000 ms", async () => {
    smartDiff.data = GROUPED;
    // `selected < total` forever: the token-capped PR, whose NORMAL exit is this
    // timeout rather than a completion.
    summaries.data = pending();
    renderTab();
    await tick(0);

    fireEvent.click(screen.getByRole("button", { name: "Summarise files" }));
    await tick(10);
    expect(screen.getByRole("button", { name: "Summarising…" })).toBeDisabled();

    // Just short of the deadline it is still waiting…
    await tick(DERIVE_TIMEOUT_MS - 1000);
    expect(screen.getByRole("button", { name: "Summarising…" })).toBeInTheDocument();

    // …and past it the control is idle again, and the status region says so.
    await tick(2000);
    expect(screen.getByRole("button", { name: "Summarise files" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("taking longer than expected");
  });
});
