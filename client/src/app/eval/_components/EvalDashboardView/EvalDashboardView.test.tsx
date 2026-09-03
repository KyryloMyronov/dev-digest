/**
 * SPEC-04 `/eval` — AC-69, AC-70, AC-71, AC-72, AC-108 (render); NFR-9, NFR-11.
 *
 * AC-72's criterion is that NO REQUEST is issued before the confirmation is
 * accepted — the dialog's presence is not the assertion, the absence of the
 * mutation call is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord, EvalDashboardAgentRow } from "@devdigest/shared";
import evalMessages from "../../../../../messages/en/eval.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/eval",
  useSearchParams: () => new URLSearchParams(),
}));

// The shell brings the sidebar, the palette and the repo context with it; none
// of that is what this screen is about.
vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const state = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  error: null as Error | null,
  estimate: { agents: 2, cases: 7, est_cost_usd: 0.14 } as unknown,
};
const runAll = vi.fn();
const estimateEnabled: boolean[] = [];

vi.mock("../../../../lib/hooks/eval", () => ({
  useEvalWorkspaceDashboard: () => ({
    data: state.data,
    isLoading: state.isLoading,
    isError: state.isError,
    error: state.error,
    refetch: vi.fn(),
  }),
  useEvalEstimate: (enabled: boolean) => {
    estimateEnabled.push(enabled);
    return { data: enabled ? state.estimate : undefined };
  },
  useRunWorkspaceEval: () => ({ mutate: runAll, isPending: false }),
}));

const { EvalDashboardView } = await import("./EvalDashboardView");

const AGENT = (over: Partial<EvalDashboardAgentRow> = {}): EvalDashboardAgentRow => ({
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 7,
  enabled: true,
  cases_total: 5,
  latest_batch_id: "b1",
  latest_ran_at: "2026-09-01T10:00:00.000Z",
  recall: 0.8,
  precision: 0.92,
  citation_accuracy: 0.75,
  traces_passed: 17,
  traces_total: 20,
  cost_usd: 0.23,
  ...over,
});

const BATCH = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord => ({
  batch_id: "b1",
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 7,
  ran_at: "2026-09-01T10:00:00.000Z",
  trigger: "manual",
  status: "complete",
  recall: 0.8,
  precision: 0.9,
  citation_accuracy: 0.7,
  traces_passed: 17,
  traces_total: 20,
  cases_ran: 20,
  cases_total: 20,
  cost_usd: 0.23,
  ...over,
});

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalDashboardView />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.data = { agents: [], batches: [], cases_total: 0 };
  state.isLoading = false;
  state.isError = false;
  state.error = null;
  state.estimate = { agents: 2, cases: 7, est_cost_usd: 0.14 };
  push.mockClear();
  runAll.mockClear();
  estimateEnabled.length = 0;
});
afterEach(cleanup);

describe("the required loading and error states", () => {
  it("paints a skeleton first — first paint is a skeleton by design", () => {
    state.isLoading = true;
    const { container } = renderView();
    expect(container.querySelector(".skeleton")).not.toBeNull();
  });

  it("renders an ApiError state with a retry", () => {
    state.isError = true;
    state.error = new Error("Cannot reach the DevDigest engine");
    renderView();
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not load the eval dashboard/i);
  });
});

describe("AC-70 — the empty state", () => {
  it("covers both `no agents` and `agents with no case`, and points at the editor", () => {
    state.data = { agents: [AGENT({ cases_total: 0 })], batches: [], cases_total: 0 };
    renderView();
    const cta = screen.getByRole("button", { name: "Go to Agents" });
    fireEvent.click(cta);
    expect(push).toHaveBeenCalledWith("/agents");
    // No "Run all agents" on a workspace with nothing to run.
    expect(screen.queryByRole("button", { name: "Run all agents" })).not.toBeInTheDocument();
  });
});

describe("AC-69 — one row per agent with its latest four values", () => {
  it("renders recall, precision, citation accuracy and the pass count", () => {
    state.data = { agents: [AGENT()], batches: [], cases_total: 5 };
    renderView();
    const row = screen.getByRole("row", { name: /Security Reviewer/ });
    expect(within(row).getByText("80%")).toBeInTheDocument();
    expect(within(row).getByText("92%")).toBeInTheDocument();
    expect(within(row).getByText("75%")).toBeInTheDocument();
    expect(within(row).getByText("17/20")).toBeInTheDocument();
  });

  it("spec D-5 — an agent with cases and no batch shows its case count and NO metrics", () => {
    state.data = {
      agents: [
        AGENT({
          latest_batch_id: null,
          latest_ran_at: null,
          recall: null,
          precision: null,
          citation_accuracy: null,
          traces_passed: null,
          traces_total: null,
        }),
      ],
      batches: [],
      cases_total: 5,
    };
    renderView();
    const row = screen.getByRole("row", { name: /Security Reviewer/ });
    expect(within(row).getByText("5 cases")).toBeInTheDocument();
    expect(within(row).getByText("never run")).toBeInTheDocument();
    // Placeholders, not zeroes: it has not scored 0, it has not run.
    expect(within(row).getAllByText("—")).toHaveLength(3);
  });

  // client/AGENTS.md — the disabled tag is a catalogue string, not an inline
  // literal, and it appears only for a disabled agent.
  it("tags a disabled agent from the message catalogue", () => {
    state.data = { agents: [AGENT({ enabled: false })], batches: [], cases_total: 5 };
    renderView();
    const row = screen.getByRole("row", { name: /Security Reviewer/ });
    expect(within(row).getByText(evalMessages.dashboard.agentDisabled)).toBeInTheDocument();
  });

  it("does not tag an enabled agent", () => {
    state.data = { agents: [AGENT()], batches: [], cases_total: 5 };
    renderView();
    const row = screen.getByRole("row", { name: /Security Reviewer/ });
    expect(within(row).queryByText(evalMessages.dashboard.agentDisabled)).not.toBeInTheDocument();
  });

  it("navigates to the agent's own eval page", () => {
    state.data = { agents: [AGENT()], batches: [], cases_total: 5 };
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Security Reviewer" }));
    expect(push).toHaveBeenCalledWith("/eval/agents/ag1");
  });
});

describe("AC-71 / AC-108 — the batch table", () => {
  it("renders the batches in the order the API returned them, newest first", () => {
    // Deliberately handed OUT OF ORDER relative to a naive sort by batch id:
    // the studio must not re-sort, and the API already ordered by ran_at desc.
    state.data = {
      agents: [AGENT()],
      cases_total: 5,
      batches: [
        BATCH({ batch_id: "zz", ran_at: "2026-09-03T00:00:00.000Z" }),
        BATCH({ batch_id: "aa", ran_at: "2026-09-02T00:00:00.000Z" }),
        BATCH({ batch_id: "mm", ran_at: "2026-09-01T00:00:00.000Z" }),
      ],
    };
    renderView();
    const tables = screen.getAllByRole("table");
    const rows = within(tables[1]!).getAllByRole("row").slice(1);
    const dates = rows.map((r) => within(r).getAllByRole("cell")[2]!.textContent);
    expect(dates).toEqual([
      "2026-09-03T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  it("renders an unpriced batch as `cost unknown`, never $0.00", () => {
    state.data = { agents: [AGENT()], cases_total: 5, batches: [BATCH({ cost_usd: null })] };
    renderView();
    expect(screen.getByText("cost unknown")).toBeInTheDocument();
  });

  // client/AGENTS.md — user-facing strings come from `messages/en/`, so the
  // wire enum must never reach the cell; `null` stays the em-dash placeholder.
  it("renders the trigger translated, not as the raw wire enum", () => {
    state.data = {
      agents: [AGENT()],
      cases_total: 5,
      batches: [
        BATCH({ batch_id: "b1", trigger: "manual" }),
        BATCH({ batch_id: "b2", trigger: "version-change" }),
        BATCH({ batch_id: "b3", trigger: null }),
      ],
    };
    renderView();
    const rows = within(screen.getAllByRole("table")[1]!).getAllByRole("row").slice(1);
    const triggers = rows.map((r) => within(r).getAllByRole("cell")[4]!.textContent);
    expect(triggers).toEqual(["Manual", "Version change", "—"]);
  });
});

describe("AC-72 — the costed confirmation", () => {
  beforeEach(() => {
    state.data = { agents: [AGENT()], batches: [BATCH()], cases_total: 5 };
  });

  it("issues NO request until the confirmation is accepted", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Run all agents" }));
    // The dialog is up and NOTHING has been sent — this is the criterion.
    expect(runAll).not.toHaveBeenCalled();
    expect(screen.getByText(/Run every agent's eval cases\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(runAll).toHaveBeenCalledTimes(1);
  });

  it("cancelling issues nothing at all", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Run all agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(runAll).not.toHaveBeenCalled();
  });

  it("shows the estimated total cost, and only fetches it once it is needed", () => {
    renderView();
    expect(estimateEnabled.every((e) => e === false)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run all agents" }));
    expect(estimateEnabled.at(-1)).toBe(true);
    expect(screen.getByText(/1 agent|2 agents/)).toHaveTextContent("$0.14");
  });

  it("renders an unknown estimate as unknown, never as $0.00", () => {
    state.estimate = { agents: 2, cases: 7, est_cost_usd: null };
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Run all agents" }));
    expect(screen.getByText(/cost unknown/)).toBeInTheDocument();
  });
});
