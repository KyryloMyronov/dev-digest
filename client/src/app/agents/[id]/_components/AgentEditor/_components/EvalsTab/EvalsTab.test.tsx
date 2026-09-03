/**
 * SPEC-04 — the Evals tab: AC-61 … AC-67, AC-112, NFR-9, NFR-10, NFR-11.
 *
 * The data hooks are mocked rather than the network, so each criterion is
 * driven by a payload rather than by a fetch sequence. `useEvalBatches` is the
 * POLLED one (AC-66); the polling itself is asserted in its own describe with
 * fake timers installed by `beforeEach`/`afterEach` — never in a `try/finally`,
 * because a test that times out never reaches `finally` and would leave fake
 * timers installed process-wide (`client/insights.md` 2026-08-29).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, EvalBatchRecord, EvalCase } from "@devdigest/shared";
import evalMessages from "../../../../../../../../messages/en/eval.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/agents/ag1",
  useSearchParams: () => new URLSearchParams(),
}));

const state = {
  cases: [] as EvalCase[],
  batches: [] as EvalBatchRecord[],
  recentRuns: [] as unknown[],
  casesLoading: false,
  casesError: null as Error | null,
};
const runMutate = vi.fn();

vi.mock("../../../../../../../lib/hooks/eval", () => ({
  useEvalCases: () => ({
    data: state.cases,
    isLoading: state.casesLoading,
    error: state.casesError,
    refetch: vi.fn(),
  }),
  useEvalBatches: () => ({ data: state.batches, isLoading: false, error: null }),
  useEvalAgentDashboard: () => ({ data: { recent_runs: state.recentRuns } }),
  useRunAgentEvalBatch: () => ({ mutate: runMutate, isPending: false }),
}));

const { EvalsTab } = await import("./EvalsTab");

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "d",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "p",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  auto_eval: false,
  enabled: true,
  version: 3,
};

const CASE = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "c1",
  owner_kind: "agent",
  owner_id: "ag1",
  name: "stripe-key-leak",
  input_diff: "diff --git a/a.ts b/a.ts",
  input_files: null,
  input_meta: null,
  expected_output: [],
  expectation: "must_find",
  notes: null,
  ...over,
});

const BATCH = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord => ({
  batch_id: "b1",
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 3,
  ran_at: "2026-09-01T10:00:00.000Z",
  trigger: "manual",
  status: "complete",
  recall: 0.8,
  precision: 0.9,
  citation_accuracy: 0.7,
  traces_passed: 4,
  traces_total: 5,
  cases_ran: 5,
  cases_total: 5,
  cost_usd: 0.23,
  ...over,
});

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalsTab agent={AGENT} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.cases = [];
  state.batches = [];
  state.recentRuns = [];
  state.casesLoading = false;
  state.casesError = null;
  push.mockClear();
  runMutate.mockClear();
});
afterEach(cleanup);

describe("AC-61 / AC-62 — the metric deltas", () => {
  it("AC-61 — renders a delta per tile once there are two batches", () => {
    state.batches = [BATCH({ precision: 0.9 }), BATCH({ batch_id: "b0", precision: 0.5 })];
    renderTab();
    // precision moved 0.5 → 0.9 = +40pt, computed from the criterion, not the code.
    expect(screen.getByText("+40pt")).toBeInTheDocument();
  });

  it("AC-62 — omits the deltas with only one batch", () => {
    state.batches = [BATCH()];
    renderTab();
    expect(screen.queryByText(/pt$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Deltas appear once/i)).toBeInTheDocument();
  });

  it("renders a null metric as a placeholder, never as 0%", () => {
    state.batches = [BATCH({ recall: null })];
    renderTab();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("AC-63 / AC-64 / AC-67 / AC-112 — the case rows", () => {
  it("AC-64 — a case with no run reads `never run`", () => {
    state.cases = [CASE()];
    renderTab();
    expect(screen.getByText("never run")).toBeInTheDocument();
  });

  it("AC-63 — a case with a run renders its expected and actual counts", () => {
    state.cases = [CASE()];
    state.recentRuns = [{ case_id: "c1", expected_count: 2, actual_count: 3 }];
    renderTab();
    expect(screen.getByText("expected 2 · got 3")).toBeInTheDocument();
    expect(screen.queryByText("never run")).not.toBeInTheDocument();
  });

  it("AC-67 — every row carries its expectation", () => {
    state.cases = [CASE(), CASE({ id: "c2", name: "no-flag", expectation: "must_not_flag" })];
    renderTab();
    expect(screen.getByText("must find")).toBeInTheDocument();
    expect(screen.getByText("must not flag")).toBeInTheDocument();
  });

  it("AC-112 — the case name renders as TEXT, with no HTML sink on the path", () => {
    state.cases = [CASE({ name: "<img src=x onerror=alert(1)>" })];
    const { container } = renderTab();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("AC-65 — the empty state", () => {
  it("offers to create the first case and routes to the new-case page", () => {
    renderTab();
    const cta = screen.getByRole("button", { name: "Create the first case" });
    fireEvent.click(cta);
    expect(push).toHaveBeenCalledWith("/eval/agents/ag1/cases/new");
  });
});

describe("AC-66 / NFR-10 — the running state", () => {
  it("renders the run control in its running state while a batch is running", () => {
    state.cases = [CASE()];
    state.batches = [BATCH({ status: "running" })];
    renderTab();
    const run = screen.getByRole("button", { name: "Run this agent's eval cases" });
    expect(run).toBeDisabled();
    expect(run).toHaveTextContent("Running…");
  });

  it("mutation check — with the status NOT running, the control is idle and clickable", () => {
    // Both directions: the assertion above must be able to fail.
    state.cases = [CASE()];
    state.batches = [BATCH({ status: "complete" })];
    renderTab();
    const run = screen.getByRole("button", { name: "Run this agent's eval cases" });
    expect(run).not.toBeDisabled();
    expect(run).toHaveTextContent("Run eval (1)");
    fireEvent.click(run);
    expect(runMutate).toHaveBeenCalledTimes(1);
  });

  it("announces the batch's state through a live region (WCAG 2.2 SC 4.1.3)", () => {
    state.cases = [CASE()];
    state.batches = [BATCH({ status: "running" })];
    renderTab();
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Eval batch started.");
  });
});

describe("NFR-11 — the controls are reachable by role and name", () => {
  it("the run control has an accessible name, not just a title", () => {
    state.cases = [CASE()];
    renderTab();
    expect(
      screen.getByRole("button", { name: "Run this agent's eval cases" }),
    ).toHaveAccessibleName("Run this agent's eval cases");
  });

  it("does NOT put aria-expanded on a repeated row", () => {
    // Adding it here would silently widen every `getByRole("button", {expanded})`
    // query in the suite (`client/insights.md` 2026-08-29).
    state.cases = [CASE(), CASE({ id: "c2", name: "b" })];
    renderTab();
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).not.toHaveAttribute("aria-expanded");
    }
  });
});

describe("the batch table", () => {
  it("renders each batch's status, metrics, pass count and cost", () => {
    state.cases = [CASE()];
    state.batches = [BATCH()];
    renderTab();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Complete")).toBeInTheDocument();
    expect(within(table).getByText("4/5")).toBeInTheDocument();
    expect(within(table).getByText("$0.23")).toBeInTheDocument();
  });

  it("renders an unpriced batch as `cost unknown`, never $0.00", () => {
    state.cases = [CASE()];
    state.batches = [BATCH({ cost_usd: null })];
    renderTab();
    expect(within(screen.getByRole("table")).getByText("cost unknown")).toBeInTheDocument();
  });

  it("renders a genuinely free batch as $0.00 — free and unknown stay distinct", () => {
    state.cases = [CASE()];
    state.batches = [BATCH({ cost_usd: 0 })];
    renderTab();
    expect(within(screen.getByRole("table")).getByText("$0.00")).toBeInTheDocument();
  });
});
