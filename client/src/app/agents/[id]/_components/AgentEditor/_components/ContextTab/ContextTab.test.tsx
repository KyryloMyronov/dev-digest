import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@devdigest/shared";
import type { AgentContextDoc, ContextDoc } from "@/lib/types";
import agentMessages from "../../../../../../../../messages/en/agents.json";
import { ContextTab } from "./ContextTab";
import { tokenTotals } from "./helpers";

/**
 * The agent Context tab (SPEC-01 AC-17, AC-23 → AC-35).
 *
 * Asserted through the ACCESSIBILITY TREE wherever the criterion says so: the
 * attach and detach controls are queried by role and accessible name, the
 * pending token indicator by its text, and the over-budget total by the words it
 * adds rather than by a colour a jsdom computed style would not resolve.
 *
 * `fetch` is stubbed at the boundary, as every other suite here does. The reason
 * the `e2e` suite still exists is exactly this: a stubbed fetch cannot see a
 * server-side join go wrong.
 */

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You review security.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

const REPO_ID = "repo-1";

const doc = (path: string, tokens: number | null, over: Partial<ContextDoc> = {}): ContextDoc => ({
  path,
  source: "specs",
  tokens,
  attached_agents: 0,
  size: 1024,
  ...over,
});

const API = doc("specs/public-api.md", 1200);
const BILLING = doc("specs/billing.md", null);
const CACHING = doc("docs/adr/0004-caching.md", 400, { source: "docs" });

const attachment = (path: string, over: Partial<AgentContextDoc> = {}): AgentContextDoc => ({
  agent_id: AGENT.id,
  path,
  order: 0,
  doc: [API, BILLING, CACHING].find((d) => d.path === path) ?? null,
  inherited_from: null,
  ...over,
});

vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({ repoId: REPO_ID, repos: [], activeRepo: null, reposLoaded: true, setRepoId: () => {} }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

let discovered: ContextDoc[];
let attachments: AgentContextDoc[];
let sent: { method: string; url: string; body: unknown }[];
/** When set, the next POST resolves only once this is called. */
let releasePost: (() => void) | null;
let failNextPost = false;
let failNextDelete = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  discovered = [API, BILLING, CACHING];
  attachments = [];
  sent = [];
  releasePost = null;
  failNextPost = false;
  failNextDelete = false;
  push.mockReset();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method !== "GET") sent.push({ method, url, body });

      if (method === "GET" && url.includes("/context-docs")) return json(attachments);
      if (method === "GET" && url.includes("/context")) {
        return json({ files: discovered, total: discovered.length, omitted: 0, scanned_at: null });
      }

      if (method === "POST") {
        if (releasePost) await new Promise<void>((r) => (releasePost = r));
        if (failNextPost) return json({ error: { code: "doc_not_found", message: "Nope." } }, 404);
        attachments = [...attachments, attachment(body.path as string, { order: attachments.length })];
        return json(attachments);
      }
      if (method === "PUT") {
        attachments = (body.paths as string[]).map((p, i) => attachment(p, { order: i }));
        return json(attachments);
      }
      if (method === "DELETE") {
        if (failNextDelete) return json({ error: { code: "conflict", message: "Nope." } }, 409);
        const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
        attachments = attachments.filter((a) => a.path !== path).map((a, i) => ({ ...a, order: i }));
        return json(attachments);
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      {/* ONLY the agents catalogue — the tab's strings are `agents.context.*`,
          so the agent editor never depends on another screen's messages. */}
      <NextIntlClientProvider locale="en" messages={{ agents: agentMessages }}>
        <ContextTab agent={AGENT} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("ContextTab — listing and counts", () => {
  // AC-17 + AC-28 + AC-31 + AC-35 in one flow: every discovered document is
  // listed with its attachment state, the header carries both counts, every row
  // carries a token count, and a null count is a pending indicator with real
  // accessible text (never a bare dash).
  it("lists every discovered document with counts, and a pending indicator for an uncounted one", async () => {
    attachments = [attachment("specs/public-api.md")];
    renderTab();

    // AC-28 — attached count AND discovered count.
    expect(await screen.findByText("1 of 3 attached")).toBeInTheDocument();

    const attachedList = screen.getByRole("list", { name: "Attached" });
    expect(within(attachedList).getByText("specs/public-api.md")).toBeInTheDocument();
    expect(within(attachedList).getByText("1200 tok")).toBeInTheDocument();

    const availableList = screen.getByRole("list", { name: "Available in this repository" });
    expect(within(availableList).getByText("specs/billing.md")).toBeInTheDocument();
    // AC-31 — a count on an UNATTACHED row too. AC-35 — null renders as pending.
    expect(within(availableList).getByText("counting…")).toBeInTheDocument();
    expect(within(availableList).getByText("400 tok")).toBeInTheDocument();
  });

  // AC-23 — an inherited row names its skill. AC-29 — an attachment whose file
  // is gone renders as unresolved, and stays removable.
  it("labels an inherited row with its skill and flags an unresolved one", async () => {
    attachments = [
      attachment("specs/public-api.md"),
      attachment("docs/adr/0004-caching.md", { inherited_from: "Security review", order: 1 }),
      { agent_id: AGENT.id, path: "specs/deleted-since.md", order: 2, doc: null, inherited_from: null },
    ];
    renderTab();

    expect(await screen.findByText("from Security review")).toBeInTheDocument();
    expect(screen.getByText("not found in this repository")).toBeInTheDocument();
    expect(screen.getByText("specs/deleted-since.md")).toBeInTheDocument();
    // Removable: the unresolved row keeps its detach control…
    expect(
      screen.getByRole("button", { name: "Detach specs/deleted-since.md" }),
    ).toBeInTheDocument();
    // …while an inherited row has none: it belongs to the skill, not the agent.
    expect(
      screen.queryByRole("button", { name: "Detach docs/adr/0004-caching.md" }),
    ).not.toBeInTheDocument();
  });

  // AC-24 — only rows whose PATH contains the typed text.
  it("filters both lists by the typed path text", async () => {
    const user = userEvent.setup();
    attachments = [attachment("specs/public-api.md")];
    renderTab();
    await screen.findByText("specs/public-api.md");

    await user.type(screen.getByRole("textbox", { name: "Filter documents by path" }), "billing");

    expect(screen.getByText("specs/billing.md")).toBeInTheDocument();
    expect(screen.queryByText("docs/adr/0004-caching.md")).not.toBeInTheDocument();
    // The attached list has no match and says so rather than rendering empty.
    expect(screen.getByText("No documents match “billing”.")).toBeInTheDocument();
  });

  // AC-32 + AC-33 — the footer sums the ATTACHED documents only, and says so in
  // words as well as in colour once the run budget is passed (NFR-9: colour is
  // never the only carrier).
  it("totals only the attached documents and marks an over-budget total", async () => {
    attachments = [attachment("specs/public-api.md")];
    renderTab();

    // 1200 attached; the unattached 400-token document is NOT counted.
    expect(await screen.findByText("1200 of 8000 tokens")).toBeInTheDocument();
    expect(screen.queryByText(/over the run budget/)).not.toBeInTheDocument();

    cleanup();
    attachments = [
      { ...attachment("specs/public-api.md"), doc: doc("specs/public-api.md", 9000) },
    ];
    renderTab();
    expect(await screen.findByText("9000 of 8000 tokens")).toBeInTheDocument();
    expect(screen.getByText(/over the run budget/)).toBeInTheDocument();
  });

  // AC-27 — nothing discovered: an empty state that links to the Project
  // Context page, with `:repoId` filled the way the sidebar fills it.
  it("links to the Project Context page when there is nothing to attach", async () => {
    const user = userEvent.setup();
    discovered = [];
    renderTab();

    expect(await screen.findByText("No documents to attach")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Project Context" }));
    expect(push).toHaveBeenCalledWith(`/repos/${REPO_ID}/context`);
  });
});

describe("ContextTab — attaching, detaching and reordering", () => {
  it("attaches a document and sends the repository with it", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("specs/public-api.md");

    await user.click(screen.getByRole("button", { name: "Attach specs/public-api.md" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("POST");
    // The repository is part of the request because the API validates the path
    // against that repository's discovered set before persisting it.
    expect(sent[0]!.body).toEqual({ repo_id: REPO_ID, path: "specs/public-api.md" });
    expect(
      await screen.findByRole("button", { name: "Detach specs/public-api.md" }),
    ).toBeInTheDocument();
  });

  // AC-25 — while THIS row's mutation is in flight, THIS row's control is
  // disabled and the others are not. The promise is held open rather than
  // awaited, which is the only way the in-flight state is observable.
  it("disables only the mutating row's attach control while it is in flight", async () => {
    const user = userEvent.setup();
    releasePost = () => {};
    renderTab();
    await screen.findByText("specs/public-api.md");

    await user.click(screen.getByRole("button", { name: "Attach specs/public-api.md" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Attach specs/public-api.md" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Attach specs/billing.md" })).toBeEnabled();

    releasePost?.();
  });

  // AC-26 — a rejected attach leaves the row in its previous (unattached) state
  // and surfaces the failure. The mirror case — a rejected DETACH restoring an
  // optimistically-removed row — is the test below it.
  it("keeps the row unattached and surfaces the error when an attach fails", async () => {
    const user = userEvent.setup();
    failNextPost = true;
    renderTab();
    await screen.findByText("specs/public-api.md");

    await user.click(screen.getByRole("button", { name: "Attach specs/public-api.md" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save that change");
    // Rolled back: the row is attachable again, and no detach control appeared.
    expect(screen.getByRole("button", { name: "Attach specs/public-api.md" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Detach specs/public-api.md" }),
    ).not.toBeInTheDocument();
  });

  // AC-26's optimistic half: a detach removes the row immediately and a
  // rejected request puts it back exactly as it was.
  it("restores an optimistically-detached row when the request fails", async () => {
    const user = userEvent.setup();
    attachments = [attachment("specs/public-api.md")];
    failNextDelete = true;
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Detach specs/public-api.md" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save that change");
    // Back in the attached list, with its detach control.
    expect(
      screen.getByRole("button", { name: "Detach specs/public-api.md" }),
    ).toBeInTheDocument();
  });

  it("detaches a document", async () => {
    const user = userEvent.setup();
    attachments = [attachment("specs/public-api.md")];
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Detach specs/public-api.md" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("DELETE");
    expect(
      await screen.findByRole("button", { name: "Attach specs/public-api.md" }),
    ).toBeInTheDocument();
  });

  // AC-19's client half: the reorder sends the FULL ordered list of the agent's
  // OWN paths in one request — an inherited row is not the agent's to reorder.
  it("sends the agent's own paths, reordered, in one request", async () => {
    attachments = [
      attachment("specs/public-api.md", { order: 0 }),
      attachment("specs/billing.md", { order: 1 }),
      attachment("docs/adr/0004-caching.md", { inherited_from: "Security review", order: 2 }),
    ];
    renderTab();
    const list = await screen.findByRole("list", { name: "Attached" });
    const rows = within(list).getAllByRole("listitem");

    // jsdom does not implement drag-and-drop, so the handlers are driven
    // directly — which is also exactly the reason NFR-6 cannot be met by this
    // control: there is no keyboard path to drive INSTEAD. See the comment in
    // ContextTab.tsx and SPEC-01's UX-2.
    const dataTransfer = { setData: () => {}, getData: () => "" };
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragStart(rows[1]!, { dataTransfer });
    fireEvent.drop(rows[0]!, { dataTransfer });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.body).toEqual({
      repo_id: REPO_ID,
      paths: ["specs/billing.md", "specs/public-api.md"],
    });
  });
});

describe("ContextTab — accessibility", () => {
  /**
   * NFR-6 (SC 2.1.1), for every control the conflict does NOT cover: the filter,
   * the attach buttons and the detach buttons are real focusable elements
   * reachable and operable from the keyboard alone. The reorder handles are the
   * documented, author-accepted exception.
   */
  it("reaches and operates the filter and the attach control from the keyboard", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("specs/public-api.md");

    const filter = screen.getByRole("textbox", { name: "Filter documents by path" });
    await user.tab();
    expect(filter).toHaveFocus();

    const attachBtn = screen.getByRole("button", { name: "Attach specs/public-api.md" });
    attachBtn.focus();
    // NFR-7 — the focus indicator comes from the kit's stylesheet
    // (`:focus-visible`), which jsdom does not resolve, so what is asserted here
    // is that the control is a genuinely focusable element that RECEIVES focus;
    // the indicator itself is a visual check.
    expect(attachBtn).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  /**
   * NFR-8 (SC 4.1.3) — the total is a STATUS MESSAGE: it updates in place, is
   * announced politely, and never takes focus.
   *
   * What is asserted is that focus does not move INTO the status region. A
   * strict before/after comparison of `document.activeElement` would be
   * meaningless here: the control the user activates legitimately leaves the
   * available list once the attach commits, so focus returns to the document
   * body for a reason that has nothing to do with the status message.
   */
  it("announces the total without taking focus", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("specs/public-api.md");

    await user.click(screen.getByRole("button", { name: "Attach specs/public-api.md" }));
    await screen.findByText("1200 of 8000 tokens");

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("1200 of 8000 tokens");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).not.toHaveFocus();
    expect(status.contains(document.activeElement)).toBe(false);
  });
});

describe("tokenTotals", () => {
  // A `null` count must never be summed as zero: a repository the token job has
  // not reached would otherwise read as comfortably under budget.
  it("sums counted documents and reports the uncounted ones separately", () => {
    expect(
      tokenTotals([
        attachment("specs/public-api.md"),
        attachment("specs/billing.md"),
        { agent_id: AGENT.id, path: "gone.md", order: 2, doc: null, inherited_from: null },
      ]),
    ).toEqual({ tokens: 1200, pendingCount: 2 });
  });
});
