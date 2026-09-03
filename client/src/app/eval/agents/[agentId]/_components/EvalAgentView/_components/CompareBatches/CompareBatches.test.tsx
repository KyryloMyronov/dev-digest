/**
 * SPEC-04 phase 2 — CompareBatches: AC-95 … AC-102.
 *
 * AC-102's criterion is that NO REQUEST is issued before the confirmation is
 * accepted, and AC-97's is that added / removed / unchanged are distinguishable
 * IN THE ACCESSIBILITY TREE — not by the background colour the eye sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AgentVersion, EvalBatchRecord } from "@devdigest/shared";
import evalMessages from "../../../../../../../../../messages/en/eval.json";
import { diffLines, wasTruncated } from "./helpers";
import { PROMPT_DIFF_MAX_CHARS } from "./constants";

const restoreMutate = vi.fn();
const state = { versions: [] as AgentVersion[] };

vi.mock("../../../../../../../../lib/hooks/agents", () => ({
  useAgentVersions: () => ({ data: state.versions }),
}));
vi.mock("../../../../../../../../lib/hooks/eval", () => ({
  useRestoreAgentVersion: () => ({ mutate: restoreMutate }),
}));

const { CompareBatches } = await import("./CompareBatches");

const BATCH = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord => ({
  batch_id: "b1",
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 6,
  ran_at: "2026-09-01T00:00:00.000Z",
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

const VERSION = (version: number, prompt: string): AgentVersion => ({
  agent_id: "ag1",
  version,
  config: {
    provider: "openai",
    model: "gpt-4.1",
    system_prompt: prompt,
    output_schema: null,
    strategy: "auto",
    ci_fail_on: "critical",
    repo_intel: false,
    skills: [],
  },
  created_at: "2026-09-01T00:00:00.000Z",
});

function renderCompare(batches: EvalBatchRecord[], onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <CompareBatches agentId="ag1" batches={batches} onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return onClose;
}

const TWO = [
  BATCH({ batch_id: "old", agent_version: 6, ran_at: "2026-09-01T00:00:00.000Z", precision: 0.9 }),
  BATCH({ batch_id: "new", agent_version: 7, ran_at: "2026-09-02T00:00:00.000Z", precision: 0.5 }),
];

beforeEach(() => {
  state.versions = [
    VERSION(6, "line one\nline two\nline three"),
    VERSION(7, "line one\nline TWO CHANGED\nline three"),
  ];
  restoreMutate.mockClear();
});
afterEach(cleanup);

describe("AC-95 — before, after and delta per metric", () => {
  it("orders by ran_at, not by selection order", () => {
    renderCompare([TWO[1]!, TWO[0]!]); // handed newest-first on purpose
    const row = screen.getByRole("row", { name: /Precision/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("90%"); // before = the OLDER batch
    expect(cells[1]).toHaveTextContent("50%"); // after  = the NEWER batch
    expect(cells[2]).toHaveTextContent("-40pt");
  });

  it("renders a null metric as a placeholder, never 0%", () => {
    renderCompare([BATCH({ recall: null, agent_version: 6 }), TWO[1]!]);
    const row = screen.getByRole("row", { name: /Recall/ });
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent("—");
  });
});

describe("AC-96 / AC-97 / AC-98 — the prompt diff", () => {
  it("AC-96 — diffs the two versions' system prompts", () => {
    renderCompare(TWO);
    expect(screen.getByText(/line TWO CHANGED/)).toBeInTheDocument();
  });

  it("AC-97 — marks each line added / removed / unchanged in the a11y tree", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines.map((l) => l.kind)).toEqual(["unchanged", "removed", "added", "unchanged"]);
    renderCompare(TWO);
    // The words are rendered, not just the colours.
    expect(screen.getAllByText(/^added$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^removed$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^unchanged$/).length).toBeGreaterThan(0);
  });

  it("AC-98 — truncates each side at 8 000 characters with a notice", () => {
    const long = "x\n".repeat(PROMPT_DIFF_MAX_CHARS);
    expect(long.length).toBeGreaterThan(PROMPT_DIFF_MAX_CHARS);
    expect(wasTruncated(long)).toBe(true);
    state.versions = [VERSION(6, long), VERSION(7, `${long}tail`)];
    renderCompare(TWO);
    expect(screen.getByText(/Truncated to the first 8,000 characters/)).toBeInTheDocument();
  });

  it("AC-100 — two batches of the SAME version render an empty diff", () => {
    renderCompare([
      BATCH({ batch_id: "a", agent_version: 7, ran_at: "2026-09-01T00:00:00.000Z" }),
      BATCH({ batch_id: "b", agent_version: 7, ran_at: "2026-09-02T00:00:00.000Z" }),
    ]);
    expect(screen.getByText(/same agent version — no prompt change/)).toBeInTheDocument();
  });

  it("AC-99 — a missing snapshot replaces the diff with a notice, metrics intact", () => {
    // `snapshotVersion` is `onConflictDoNothing`, so a version may legitimately
    // have no row.
    state.versions = [VERSION(6, "only the old one exists")];
    renderCompare(TWO);
    expect(screen.getByText(/Snapshot unavailable/)).toBeInTheDocument();
    // The metrics still render — only the diff is replaced.
    expect(screen.getByRole("row", { name: /Precision/ })).toBeInTheDocument();
  });
});

describe("AC-101 / AC-102 — restore", () => {
  it("AC-101 — the control names the OLDER version and reads Restore", () => {
    renderCompare(TWO);
    expect(screen.getByRole("button", { name: "Restore v6" })).toBeInTheDocument();
    // Not "Promote v7" — v7 is already current, so promoting it is a no-op.
    expect(screen.queryByRole("button", { name: /Promote/ })).not.toBeInTheDocument();
  });

  it("AC-102 — issues NO request until the confirmation is accepted", () => {
    renderCompare(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Restore v6" }));
    expect(restoreMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/Restore v6\?/)).toBeInTheDocument();

    fireEvent.click(// An exact string match — "Restore v6" is a different accessible name.
      screen.getByRole("button", { name: "Restore" }));
    expect(restoreMutate).toHaveBeenCalledWith(6);
  });

  it("cancelling the confirmation issues nothing", () => {
    renderCompare(TWO);
    fireEvent.click(screen.getByRole("button", { name: "Restore v6" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(restoreMutate).not.toHaveBeenCalled();
  });
});

describe("the diff helper on its own", () => {
  it("reports an identical pair as entirely unchanged", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.kind === "unchanged")).toBe(true);
  });

  it("reports a pure insertion as added only", () => {
    expect(diffLines("a", "a\nb").map((l) => l.kind)).toEqual(["unchanged", "added"]);
  });

  it("reports a pure deletion as removed only", () => {
    expect(diffLines("a\nb", "a").map((l) => l.kind)).toEqual(["unchanged", "removed"]);
  });
});
