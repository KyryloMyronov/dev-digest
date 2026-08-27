import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { RunTrace } from "@devdigest/shared";
import messages from "../../../../../../../../../../messages/en/runs.json";
import { TraceBody } from "./TraceBody";

/**
 * The trace drawer's project-context surface (SPEC-01 AC-52, AC-53, AC-54's
 * client half, AC-55).
 *
 * Almost nothing here was built by SPEC-01 — the block already rendered
 * conditionally and *Specs read* already had a `none` fallback. These tests are
 * what pins all four criteria, including the one-key label change, so a later
 * "tidy-up" of the label or of the conditional is caught.
 *
 * TWO THINGS THAT LOOK WRONG AND ARE NOT:
 *  · Row order does not match the spec's mock. The engine emits `## Repo
 *    skeleton` BEFORE `## Project context` (see `reviewer-core/src/prompt.ts`,
 *    "so the model sees structure first") and this component renders in engine
 *    order. The mock's order is the accepted inaccuracy.
 *  · `specs_skipped` is persisted and NOT rendered. No criterion asks the studio
 *    to show it; the Live Log lines are its user-facing surface.
 */

const SPECS_BLOCK =
  '<untrusted source="specs/public-api.md">\nAUTH-IS-REQUIRED-ON-EVERY-ENDPOINT\n</untrusted>';

const trace = (over: Partial<RunTrace> = {}): RunTrace => ({
  config: {
    agent: "Security",
    version: "1",
    provider: "openai",
    model: "gpt-4.1",
    pr: 482,
    source: "local",
  },
  stats: {
    duration_ms: 8200,
    tokens_in: 12000,
    tokens_out: 1500,
    cost_usd: 0.06,
    findings: 0,
    grounding: "1/1 passed",
  },
  prompt_assembly: {
    system: "You are a reviewer.",
    skills: null,
    memory: null,
    repo_map: "SKELETON",
    specs: SPECS_BLOCK,
    user: "## Repo skeleton\n## Project context\n## Diff to review",
  },
  tool_calls: [],
  raw_output: "{}",
  memory_pulled: [],
  specs_read: ["specs/public-api.md", "docs/adr/0004-caching.md"],
  specs_skipped: [{ path: "specs/huge.md", reason: "budget" }],
  log: [],
  ...over,
});

afterEach(cleanup);

function renderBody(t: RunTrace) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ runs: messages }}>
      <div data-theme="dark">
        <TraceBody trace={t} findings={[]} />
      </div>
    </NextIntlClientProvider>,
  );
}

/**
 * The Prompt assembly section ships collapsed (`defaultOpen={false}`), so the
 * blocks do not exist until a reviewer opens it. Its head is a role-less div
 * carrying the section title — the same locator the e2e flow drives.
 */
async function openPromptAssembly(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Prompt assembly"));
}

describe("TraceBody — project context", () => {
  // AC-52 + AC-53 — the block renders for a non-null project context, under the
  // label AC-53 specifies verbatim.
  it("renders the project-context block with its untrusted label", async () => {
    const user = userEvent.setup();
    renderBody(trace());
    await openPromptAssembly(user);
    expect(
      screen.getByText("Project context — attached specs (untrusted)"),
    ).toBeInTheDocument();
  });

  // AC-52's other half — a run with no attachments legitimately has no block,
  // and the conditional is what keeps it out. Keep the conditional.
  it("omits the block entirely when the trace carries none", async () => {
    const user = userEvent.setup();
    renderBody(trace({ prompt_assembly: { ...trace().prompt_assembly, specs: null } }));
    await openPromptAssembly(user);
    expect(
      screen.queryByText("Project context — attached specs (untrusted)"),
    ).not.toBeInTheDocument();
  });

  // AC-54 (client half, D-OQ7) — activating the block's own EXPAND control
  // renders the full injected text. This is the strict reading of the criterion;
  // the e2e flow reaches the same observation through the fullscreen control.
  it("renders the full injected text when the block's expand control is activated", async () => {
    const user = userEvent.setup();
    renderBody(trace());
    await openPromptAssembly(user);

    expect(screen.queryByText(/AUTH-IS-REQUIRED-ON-EVERY-ENDPOINT/)).not.toBeInTheDocument();

    // The head is a role-less div (it carries the label and an "expand" hint),
    // so it is reached through the label's own row rather than by role.
    const label = screen.getByText("Project context — attached specs (untrusted)");
    const head = label.parentElement!;
    await user.click(within(head).getByText("expand"));

    expect(screen.getByText(/AUTH-IS-REQUIRED-ON-EVERY-ENDPOINT/)).toBeInTheDocument();
    // The fence label carries the document's path (AC-60), which is what makes
    // the block and *Specs read* below name the same thing.
    expect(screen.getByText(/source="specs\/public-api.md"/)).toBeInTheDocument();
  });

  // AC-55 — the injected paths in the Configuration section's *Specs read* row.
  it("lists every injected document path under Specs read", () => {
    renderBody(trace());
    expect(screen.getByText("specs/public-api.md")).toBeInTheDocument();
    expect(screen.getByText("docs/adr/0004-caching.md")).toBeInTheDocument();
  });

  it("falls back to 'none' when the run injected nothing", () => {
    renderBody(trace({ specs_read: [] }));
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  // The engine's order, not the mock's (D-19).
  it("renders the repo skeleton block before the project-context block", async () => {
    const user = userEvent.setup();
    renderBody(trace());
    await openPromptAssembly(user);
    const labels = screen
      .getAllByText(/Repo skeleton|Project context — attached specs/)
      .map((el) => el.textContent);
    expect(labels[0]).toContain("Repo skeleton");
    expect(labels[1]).toContain("Project context");
  });
});
