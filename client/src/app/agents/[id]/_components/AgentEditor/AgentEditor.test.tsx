import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../../messages/en/agents.json";
import evalMessages from "../../../../../../messages/en/eval.json";
import { ToastProvider } from "../../../../../lib/toast";

// Mock the data hooks so the editor renders without a network/query client.
vi.mock("../../../../../lib/hooks/agents", () => ({
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined }),
  useProviderModels: () => ({ data: [{ id: "gpt-4.1", provider: "openai" }] }),
}));

// SPEC-01's Context tab pushes on the router from its empty state.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/agents/ag1",
  useSearchParams: () => new URLSearchParams(),
}));

import { AgentEditor } from "./AgentEditor";

afterEach(cleanup);

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  auto_eval: false,
  enabled: true,
  version: 1,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
      <ToastProvider>{ui}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

describe("A2 Agent Editor (smoke)", () => {
  it("renders the Config tab fields", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);
    expect(screen.getByText("Config")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Save agent")).toBeInTheDocument();
  });

  /**
   * SPEC-01 — the Context tab, mounted with THIS screen's catalogue only and
   * with a `fetch` that does not know its endpoints.
   *
   * Two defect classes are pinned here, both of which took the skill editor down
   * before they were fixed: a component reading another screen's i18n namespace
   * throws MISSING_MESSAGE, and a list component handed a truthy non-array
   * throws during render. The test above renders only the Config tab, so it
   * would have passed either way — this one is what stops that being luck.
   */
  it("renders the Context tab from the agents catalogue and survives a wrong-shaped payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
          <ToastProvider>
            <AgentEditor agent={AGENT} tab="context" onTab={() => {}} />
          </ToastProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    // The tab exists in the tab strip…
    expect(screen.getByText("Context")).toBeInTheDocument();
    // …and it degrades to its empty state instead of throwing.
    await waitFor(() =>
      expect(screen.getByText("No documents to attach")).toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  });

  /**
   * SPEC-04 AC-59 / AC-60 — the Evals tab, MOUNTED.
   *
   * The two tests above render `tab="config"` and `tab="context"`; neither would
   * notice a broken Evals tab. This is the SPEC-01 sibling trap
   * (`client/insights.md` 2026-08-27) and the reason this test exists at all.
   *
   * The `fetch` stub returns a real ARRAY. A truthy non-array satisfies `?.` and
   * then throws on `.map`, unmounting the tree and failing every assertion in
   * this FILE with an error that points nowhere near the cause.
   */
  it("renders the Evals tab body when mounted with tab='evals'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("/eval/agents/")
              ? { cases_total: 0, batches: [], recent_runs: [], current: {}, delta: {}, trend: [] }
              : [],
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={{ agents: messages, eval: evalMessages }}>
          <ToastProvider>
            <AgentEditor agent={AGENT} tab="evals" onTab={() => {}} />
          </ToastProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    // AC-59 — the tab is in the strip.
    expect(screen.getByText("Evals")).toBeInTheDocument();
    // AC-60 + AC-65 — the BODY rendered, and with no cases it offers to make one.
    await waitFor(() =>
      expect(screen.getByText(/No eval cases yet/i)).toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  });
});
