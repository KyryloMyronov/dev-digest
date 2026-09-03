/**
 * SPEC-04 `/eval/agents/:agentId` — AC-73, AC-74, AC-75; NFR-8, NFR-9.
 *
 * AC-74's point is what the banner does NOT say. The API sends a metric name
 * and a number; the sentence is composed here from `eval.json` and claims no
 * cause (plan D-14, spec D-31, UX-3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord } from "@devdigest/shared";
import evalMessages from "../../../../../../../messages/en/eval.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/eval/agents/ag1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ agentId: "ag1" }),
}));

vi.mock("../../../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const state = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
};

vi.mock("../../../../../../lib/hooks/eval", () => ({
  useEvalAgentDashboard: () => ({
    data: state.data,
    isLoading: state.isLoading,
    isError: state.isError,
    error: new Error("boom"),
    refetch: vi.fn(),
  }),
  useRestoreAgentVersion: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../../../../../lib/hooks/agents", () => ({
  useAgentVersions: () => ({ data: [] }),
}));

const { EvalAgentView } = await import("./EvalAgentView");

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

const dashboard = (over: Record<string, unknown> = {}) => ({
  owner_kind: "agent",
  owner_id: "ag1",
  cases_total: 20,
  current: {
    recall: 0.8,
    precision: 0.9,
    citation_accuracy: 0.7,
    traces_passed: 17,
    traces_total: 20,
    cost_usd: 0.23,
  },
  delta: { recall: 0, precision: 0, citation_accuracy: 0 },
  trend: [],
  recent_runs: [],
  alert: null,
  batches: [BATCH()],
  alert_metric: null,
  alert_delta: null,
  agent_name: "Security Reviewer",
  agent_version: 7,
  ...over,
});

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalAgentView agentId="ag1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.data = dashboard();
  state.isLoading = false;
  state.isError = false;
  push.mockClear();
});
afterEach(cleanup);

describe("the required loading and error states", () => {
  it("paints a skeleton first", () => {
    state.isLoading = true;
    const { container } = renderView();
    expect(container.querySelector(".skeleton")).not.toBeNull();
  });

  it("renders an ApiError state", () => {
    state.isError = true;
    renderView();
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not load this agent/i);
  });
});

describe("AC-73 — tiles, trend and recent batches", () => {
  it("renders the three metric tiles from the latest batch", () => {
    renderView();
    const tile = (label: string) => screen.getByText(label).parentElement!;
    expect(within(tile("RECALL")).getByText("80%")).toBeInTheDocument();
    expect(within(tile("PRECISION")).getByText("90%")).toBeInTheDocument();
    expect(within(tile("CITATION ACCURACY")).getByText("70%")).toBeInTheDocument();
  });

  it("renders the trend", () => {
    state.data = dashboard({ batches: [BATCH(), BATCH({ batch_id: "b0" })] });
    const { container } = renderView();
    expect(container.querySelectorAll("path[data-series]")).toHaveLength(3);
  });

  it("AC-75 — the trend's ordinals run oldest-first, left to right", () => {
    // The API serves NEWEST first; the trend must reverse it, or ordinal 1 is
    // the most recent batch and the line runs backwards.
    state.data = dashboard({
      batches: [
        BATCH({ batch_id: "new", ran_at: "2026-09-03T00:00:00.000Z", recall: 0.2 }),
        BATCH({ batch_id: "old", ran_at: "2026-09-01T00:00:00.000Z", recall: 0.9 }),
      ],
    });
    renderView();
    const table = screen.getByRole("table", { name: /Metric trend/i });
    const firstRow = within(table).getByRole("rowheader", { name: "Batch 1 of 2" }).closest("tr")!;
    // The recall CELL of ordinal 1 must hold the OLDER batch's value (0.9).
    expect(within(firstRow).getAllByRole("cell")[0]).toHaveTextContent("90%");
    const lastRow = within(table).getByRole("rowheader", { name: "Batch 2 of 2" }).closest("tr")!;
    expect(within(lastRow).getAllByRole("cell")[0]).toHaveTextContent("20%");
  });

  it("renders the recent-batches table", () => {
    renderView();
    const tables = screen.getAllByRole("table");
    const batchTable = tables[tables.length - 1]!;
    expect(within(batchTable).getByText("v7")).toBeInTheDocument();
    expect(within(batchTable).getByText("17/20")).toBeInTheDocument();
  });
});

describe("AC-74 — the regression banner", () => {
  it("renders from alert_metric + alert_delta, composed in the studio", () => {
    state.data = dashboard({ alert_metric: "precision", alert_delta: 0.04 });
    renderView();
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("precision fell by 4pt against the previous batch.");
  });

  it("claims NO cause — the sentence has no causal clause", () => {
    state.data = dashboard({ alert_metric: "precision", alert_delta: 0.04 });
    renderView();
    const banner = screen.getByRole("status");
    // "a new false positive slipped in" is an inference code cannot make.
    expect(banner.textContent).not.toMatch(/because|false positive|due to|caused/i);
  });

  it("renders no banner when the API reported no alert", () => {
    renderView();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not read the server's convenience `alert` string", () => {
    state.data = dashboard({
      alert: "SERVER SENTENCE THAT MUST NOT BE RENDERED",
      alert_metric: null,
      alert_delta: null,
    });
    const { container } = renderView();
    expect(container.textContent).not.toContain("SERVER SENTENCE");
  });
});

describe("AC-93 / AC-94 — the Compare control", () => {
  const three = [
    BATCH({ batch_id: "b1" }),
    BATCH({ batch_id: "b2" }),
    BATCH({ batch_id: "b3" }),
  ];

  it("is disabled with none selected", () => {
    state.data = dashboard({ batches: three });
    renderView();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
  });

  it("is enabled at exactly two and disabled at one and at three", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    state.data = dashboard({ batches: three });
    renderView();
    const boxes = screen.getAllByRole("checkbox");
    const compare = () => screen.getByRole("button", { name: "Compare" });

    await user.click(boxes[0]!);
    expect(compare()).toBeDisabled();
    await user.click(boxes[1]!);
    expect(compare()).not.toBeDisabled();
    await user.click(boxes[2]!);
    expect(compare()).toBeDisabled();
  });
});
