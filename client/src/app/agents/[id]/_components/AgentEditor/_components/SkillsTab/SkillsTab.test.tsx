import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentSkillDetail, Skill } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/agents.json";
import { moveItem, toLinkPayload } from "./helpers";
import { SkillsTab } from "./SkillsTab";

/**
 * The Skills tab is where the feature's three distinct actions live, and the
 * one that is easy to get wrong is the separation between ATTACHED and ENABLED:
 * a reorder must not re-enable a disabled link, and a disabled link must keep
 * its position. Both are asserted against the request body, because a wrong
 * payload still renders a plausible-looking UI from the server's response.
 */

const AGENT: Agent = {
  id: "ag1",
  name: "Test Quality Reviewer",
  description: "",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  system_prompt: "You review tests.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  auto_eval: false,
  enabled: true,
  version: 1,
};

const skill = (id: string, name: string, over: Partial<Skill> = {}): Skill => ({
  id,
  name,
  description: `Apply when ${name}.`,
  type: "rubric",
  source: "manual",
  body: `# ${name}`,
  enabled: true,
  version: 1,
  evidence_files: null,
  ...over,
});

const link = (sk: Skill, order: number, enabled = true): AgentSkillDetail => ({
  agent_id: AGENT.id,
  skill_id: sk.id,
  order,
  enabled,
  skill: sk,
});

const BRANCHES = skill("sk1", "uncovered-branches");
const CORNERS = skill("sk2", "corner-cases");
const MOCKING = skill("sk3", "mocking-discipline");

let fetchMock: ReturnType<typeof vi.fn>;
/** Bodies of every non-GET request, in order. */
let sent: { method: string; url: string; body: unknown }[];

/** Links the fake server currently holds; mutations echo an updated list back. */
let serverLinks: AgentSkillDetail[];

beforeEach(() => {
  serverLinks = [link(BRANCHES, 0), link(CORNERS, 1, false)];
  sent = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method !== "GET") sent.push({ method, url, body });

    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.endsWith("/skills") && method === "GET" && !url.includes("/agents/")) {
      return json([BRANCHES, CORNERS, MOCKING]);
    }
    if (url.includes(`/agents/${AGENT.id}/skills`) && method === "GET") return json(serverLinks);
    if (method === "POST" && url.endsWith(`/agents/${AGENT.id}/skills`)) {
      serverLinks = (body.links as { skill_id: string; enabled?: boolean }[]).map((l, i) => {
        const sk = [BRANCHES, CORNERS, MOCKING].find((s) => s.id === l.skill_id)!;
        return link(sk, i, l.enabled ?? true);
      });
      return json(serverLinks);
    }
    if (method === "PATCH") {
      const skillId = url.split("/").pop()!;
      serverLinks = serverLinks.map((l) =>
        l.skill_id === skillId ? { ...l, enabled: body.enabled } : l,
      );
      return json(serverLinks);
    }
    if (method === "DELETE") {
      const skillId = url.split("/").pop()!;
      serverLinks = serverLinks
        .filter((l) => l.skill_id !== skillId)
        .map((l, i) => ({ ...l, order: i }));
      return json(serverLinks);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
        <SkillsTab agent={AGENT} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The last request body sent, for asserting what a click actually wrote. */
const lastBody = () => sent.at(-1)?.body as { links: { skill_id: string; enabled: boolean }[] };

describe("SkillsTab", () => {
  it("lists the attached skills in order and counts the enabled ones", async () => {
    renderTab();
    expect(await screen.findByText("uncovered-branches")).toBeInTheDocument();
    expect(screen.getByText("corner-cases")).toBeInTheDocument();
    // 2 attached, only 1 enabled.
    expect(screen.getByText("1 of 2 enabled")).toBeInTheDocument();
  });

  it("shows a disabled link as attached, unchecked, and still in place", async () => {
    renderTab();
    await screen.findByText("corner-cases");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).toHaveAttribute("aria-checked", "true");
    expect(boxes[1]).toHaveAttribute("aria-checked", "false");
  });

  it("toggling a link PATCHes only that link, leaving the order alone", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("corner-cases");

    await user.click(screen.getAllByRole("checkbox")[1]!);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", body: { enabled: true } });
    expect(sent[0]!.url).toContain(`/agents/${AGENT.id}/skills/${CORNERS.id}`);
  });

  it("reordering PRESERVES each link's enabled flag", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("corner-cases");

    // Move the disabled second skill up.
    await user.click(screen.getByLabelText("Move corner-cases up"));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The regression this guards: sending only skill_ids, which the server
    // attaches as enabled — silently switching a disabled skill back on.
    expect(lastBody().links).toEqual([
      { skill_id: CORNERS.id, enabled: false },
      { skill_id: BRANCHES.id, enabled: true },
    ]);
  });

  it("disables the up arrow on the first row and the down arrow on the last", async () => {
    renderTab();
    await screen.findByText("corner-cases");
    expect(screen.getByLabelText("Move uncovered-branches up")).toBeDisabled();
    expect(screen.getByLabelText("Move corner-cases down")).toBeDisabled();
    expect(screen.getByLabelText("Move uncovered-branches down")).toBeEnabled();
  });

  it("offers only the unattached skills, and attaching appends to the end", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("corner-cases");

    const attach = screen.getByRole("button", { name: "mocking-discipline" });
    await user.click(attach);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(lastBody().links).toEqual([
      { skill_id: BRANCHES.id, enabled: true },
      { skill_id: CORNERS.id, enabled: false },
      { skill_id: MOCKING.id, enabled: true },
    ]);
  });

  it("marks a link whose skill is switched off in the library", async () => {
    serverLinks = [link({ ...BRANCHES, enabled: false }, 0)];
    renderTab();
    // The checkbox can be on while the skill is globally off; without this badge
    // the row would claim to be contributing to the prompt when it is not.
    expect(await screen.findByText("off in the library")).toBeInTheDocument();
  });

  it("detaching removes the row and returns the skill to the attachable list", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("corner-cases");

    await user.click(screen.getByLabelText("Detach corner-cases from this agent"));

    // The ROW is gone — asserted via its detach control, since the skill's name
    // legitimately reappears as an "attach" button below.
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Detach corner-cases from this agent"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "corner-cases" })).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ method: "DELETE" });
  });
});

describe("SkillsTab helpers", () => {
  it("moveItem returns a new array with the item relocated", () => {
    const src = ["a", "b", "c"];
    expect(moveItem(src, 2, 0)).toEqual(["c", "a", "b"]);
    expect(src).toEqual(["a", "b", "c"]);
  });

  it("moveItem leaves the list alone for an out-of-range index", () => {
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });

  it("toLinkPayload carries enabled through", () => {
    expect(toLinkPayload([link(BRANCHES, 0), link(CORNERS, 1, false)])).toEqual([
      { skill_id: "sk1", enabled: true },
      { skill_id: "sk2", enabled: false },
    ]);
  });
});
