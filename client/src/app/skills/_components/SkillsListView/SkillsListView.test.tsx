import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Skill } from "@devdigest/shared";
import skillMessages from "../../../../../messages/en/skills.json";
import shellMessages from "../../../../../messages/en/shell.json";
import { SkillsListView } from "./SkillsListView";

/**
 * Covers the two acceptance criteria that live entirely on this screen: a skill
 * can be created and edited in the UI, and an imported skill is previewed —
 * with its non-markdown members named and dropped — before anything is saved.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/skills",
  useSearchParams: () => new URLSearchParams(),
}));

const RUBRIC: Skill = {
  id: "sk1",
  name: "uncovered-branches",
  description: "Apply when the diff adds a conditional.",
  type: "rubric",
  source: "manual",
  body: "# Uncovered branches\n\nEnumerate the outcomes.",
  enabled: true,
  version: 2,
  evidence_files: null,
};

const IMPORTED: Skill = {
  ...RUBRIC,
  id: "sk2",
  name: "test-flake-signals",
  source: "imported_url",
  type: "convention",
  enabled: false,
};

let skills: Skill[];
let sent: { method: string; url: string; body: any }[];

beforeEach(() => {
  skills = [RUBRIC, IMPORTED];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method !== "GET") sent.push({ method, url, body });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (/\/skills\/[^/]+\/agents$/.test(url)) return json(["Test Quality Reviewer"]);
      if (method === "GET" && url.endsWith("/skills")) return json(skills);
      if (method === "POST" && url.endsWith("/skills")) {
        const created: Skill = {
          id: "sk3",
          enabled: true,
          version: 1,
          evidence_files: null,
          type: "custom",
          source: "manual",
          ...body,
        };
        skills = [...skills, created];
        return json(created);
      }
      if (method === "PUT") {
        const id = url.split("/").pop()!;
        skills = skills.map((s) => (s.id === id ? { ...s, ...body } : s));
        return json(skills.find((s) => s.id === id));
      }
      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={{ skills: skillMessages, shell: shellMessages }}
      >
        <SkillsListView />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsListView", () => {
  it("renders a card per skill with its type", async () => {
    renderView();
    expect(await screen.findByText("uncovered-branches")).toBeInTheDocument();
    expect(screen.getByText("test-flake-signals")).toBeInTheDocument();
    expect(screen.getByText("convention")).toBeInTheDocument();
  });

  it("badges a skill that came from outside the workspace", async () => {
    renderView();
    await screen.findByText("test-flake-signals");
    expect(screen.getByText("imported")).toBeInTheDocument();
  });

  it("filters by name", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("uncovered-branches");

    await user.type(screen.getByLabelText("Search skills…"), "flake");

    expect(screen.queryByText("uncovered-branches")).not.toBeInTheDocument();
    expect(screen.getByText("test-flake-signals")).toBeInTheDocument();
  });

  it("opens a preview beside the grid when a card is clicked", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("uncovered-branches"));

    // Scoped to the panel: the description also shows on the card, so an
    // unscoped query would pass whether or not the preview opened at all.
    const panel = within(await screen.findByRole("complementary", { name: "Skill preview" }));
    expect(await panel.findByText("Test Quality Reviewer")).toBeInTheDocument();
    expect(panel.getByText("Apply when the diff adds a conditional.")).toBeInTheDocument();
    expect(panel.getByText("Enumerate the outcomes.")).toBeInTheDocument();
  });

  it("creates a skill from the UI", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("uncovered-branches");

    await user.click(screen.getByRole("button", { name: /Add Skill/ }));
    await user.click(await screen.findByText("Create from scratch"));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("uncovered-branches"), "my-new-skill");
    await user.type(within(dialog).getByPlaceholderText("Apply when… Report…"), "Apply always.");
    await user.type(within(dialog).getByPlaceholderText(/# Rule/), "# Rule");

    await user.click(within(dialog).getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: { name: "my-new-skill", description: "Apply always.", body: "# Rule" },
    });
    // A hand-written skill must NOT claim an imported origin.
    expect(sent[0]!.body.source).toBeUndefined();
  });

  it("edits an existing skill", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText("uncovered-branches"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog");
    const body = within(dialog).getByDisplayValue(/# Uncovered branches/);
    await user.clear(body);
    await user.type(body, "# Rewritten");
    await user.click(within(dialog).getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", body: { body: "# Rewritten" } });
    expect(sent[0]!.url).toContain("/skills/sk1");
  });

  it("import previews the file and saves nothing until the editor is confirmed", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("uncovered-branches");

    await user.click(screen.getByRole("button", { name: /Add Skill/ }));
    await user.click(await screen.findByText("Import from file…"));

    const file = new File(
      ["---\nname: imported-rule\ndescription: Apply when imported.\ntype: security\n---\n# Imported\n"],
      "imported-rule.md",
      { type: "text/markdown" },
    );
    await user.upload(screen.getByLabelText("Skill file"), file);

    // Parsed and shown…
    expect(await screen.findByText("imported-rule")).toBeInTheDocument();
    expect(screen.getByText("Apply when imported.")).toBeInTheDocument();
    // …and nothing has been written.
    expect(sent).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Review and save…" }));

    // Still nothing written — accepting only opens the editor.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("imported-rule")).toBeInTheDocument();
    expect(sent).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The origin is recorded, which is what badges it and labels its prompt block.
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: { name: "imported-rule", type: "security", source: "imported_url" },
    });
  });
});
