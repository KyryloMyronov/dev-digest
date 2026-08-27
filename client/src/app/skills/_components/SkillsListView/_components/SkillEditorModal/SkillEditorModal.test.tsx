import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Skill } from "@devdigest/shared";
import type { ContextDoc, SkillContextDoc } from "@/lib/types";
import skillMessages from "../../../../../../../messages/en/skills.json";
import { SkillEditorModal } from "./SkillEditorModal";

/**
 * The skill editor's project-context surface (SPEC-01 AC-20's UI, AC-31, AC-32).
 *
 * The modal is the one that EXISTS: SPEC-01's Non-goals rule out converting the
 * skill editor into a routed, tabbed page, so this suite drives the modal as it
 * is and asserts only the surface the spec asked for.
 */

const SKILL: Skill = {
  id: "sk1",
  name: "Security review",
  description: "Apply when auth changes.",
  type: "security",
  source: "manual",
  body: "# Rule",
  enabled: true,
  version: 1,
  evidence_files: null,
};

const REPO_ID = "repo-1";

const API: ContextDoc = {
  path: "specs/public-api.md",
  source: "specs",
  tokens: 1200,
  attached_agents: 1,
  size: 2048,
};
const BILLING: ContextDoc = {
  path: "specs/billing.md",
  source: "specs",
  tokens: null,
  attached_agents: 0,
  size: 512,
};

vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: REPO_ID,
    repos: [],
    activeRepo: null,
    reposLoaded: true,
    setRepoId: () => {},
  }),
}));

let attached: SkillContextDoc[];
let sent: { method: string; url: string; body: unknown }[];

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  attached = [];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method !== "GET") sent.push({ method, url, body });

      if (method === "GET" && url.includes("/context-docs")) return json(attached);
      if (method === "GET" && url.includes("/context")) {
        return json({ files: [API, BILLING], total: 2, omitted: 0, scanned_at: null });
      }
      if (method === "POST" && url.includes("/context-docs")) {
        attached = [
          ...attached,
          { skill_id: SKILL.id, path: body.path as string, order: attached.length, doc: API },
        ];
        return json(attached);
      }
      if (method === "DELETE") {
        const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
        attached = attached.filter((a) => a.path !== path);
        return json(attached);
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal(skill?: Skill) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      {/* ONLY this screen's catalogue: the surface must not depend on the
          Project Context page's messages (`skills.context.*`, not `context.*`). */}
      <NextIntlClientProvider locale="en" messages={{ skills: skillMessages }}>
        <SkillEditorModal skill={skill} onClose={() => {}} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("SkillEditorModal — project context", () => {
  // AC-20's UI + AC-31 + AC-32: the surface lists what the skill attaches, every
  // row carries a token count, and the footer totals the attached documents.
  it("attaches a document to the skill and totals the attached tokens", async () => {
    const user = userEvent.setup();
    renderModal(SKILL);

    expect(await screen.findByText("Project context")).toBeInTheDocument();
    // The surface loads its own two queries, so wait for the settled empty state
    // rather than the field label (which renders immediately).
    expect(await screen.findByText("No documents attached yet.")).toBeInTheDocument();
    expect(screen.getByText("0 of 8000 tokens")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "specs/public-api.md" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.body).toEqual({ repo_id: REPO_ID, path: "specs/public-api.md" });

    const list = await screen.findByRole("list", { name: "Attached" });
    expect(within(list).getByText("specs/public-api.md")).toBeInTheDocument();
    expect(within(list).getByText("1200 tok")).toBeInTheDocument();
    // AC-32 — attached only; the unattached document's count is not in the sum.
    expect(await screen.findByText("1200 of 8000 tokens")).toBeInTheDocument();
  });

  it("detaches a document from the skill", async () => {
    const user = userEvent.setup();
    attached = [{ skill_id: SKILL.id, path: "specs/public-api.md", order: 0, doc: API }];
    renderModal(SKILL);

    await user.click(await screen.findByRole("button", { name: "Detach specs/public-api.md" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("DELETE");
    expect(await screen.findByText("No documents attached yet.")).toBeInTheDocument();
  });

  // An attachment is a row keyed by `skill_id`, so there is nothing to attach to
  // until the skill exists. The create path says so rather than showing a dead
  // control.
  it("tells the user to save first when creating a skill", async () => {
    renderModal(undefined);
    expect(
      await screen.findByText("Save the skill first — documents are attached to a saved skill."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Attached" })).not.toBeInTheDocument();
  });
});
