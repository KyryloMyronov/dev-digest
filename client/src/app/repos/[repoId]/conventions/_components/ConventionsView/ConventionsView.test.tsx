import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConventionCandidate, ConventionScan } from "@devdigest/shared";
import conventionMessages from "../../../../../../../messages/en/conventions.json";
import shellMessages from "../../../../../../../messages/en/shell.json";
import { RepoProvider } from "@/lib/repo-context";
import { ConventionsView } from "./ConventionsView";

/**
 * Covers the user stories that live entirely on this screen: see the derived
 * conventions, accept / reject / edit one, and open the create-skill modal over
 * the accepted set — then save it.
 *
 * Two assertions carry most of the weight:
 *  - the accepted counter is asserted to MOVE after an accept, which is what pins
 *    it to the server list rather than to local state that could drift from it;
 *  - opening the modal is asserted to write NOTHING, which is the whole point of
 *    the draft endpoint being read-only.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/repos/r1/conventions",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ repoId: "r1" }),
}));

const REPO = {
  id: "r1",
  owner: "acme",
  name: "payments-api",
  full_name: "acme/payments-api",
  default_branch: "main",
  last_polled_at: null,
  indexed: true,
};

function candidate(over: Partial<ConventionCandidate> = {}): ConventionCandidate {
  return {
    id: "cv1",
    repo_id: "r1",
    rule: "Always use async/await instead of .then() chains.",
    evidence_path: "src/api/users.ts",
    evidence_snippet: "const user = await db.users.find(id);",
    confidence: 0.91,
    status: "pending",
    edited: false,
    created_at: "2026-08-11T08:00:00.000Z",
    updated_at: "2026-08-11T08:00:00.000Z",
    last_seen_at: "2026-08-11T08:00:00.000Z",
    ...over,
  };
}

const SCAN: ConventionScan = {
  repo_id: "r1",
  status: "done",
  reason: null,
  sample_files: 84,
  selected_files: 12,
  candidates_found: 3,
  new_candidates: 3,
  provider: "openai",
  model: "gpt-5.4",
  started_at: "2026-08-11T08:00:00.000Z",
  finished_at: "2026-08-11T08:00:30.000Z",
  error: null,
};

const DRAFT = {
  name: "payments-api-conventions",
  description: "2 house conventions extracted from payments-api",
  type: "convention" as const,
  source: "extracted" as const,
  body: "# payments-api-conventions\n\nHouse conventions.\n\n## always-use-async-await\nAlways use async/await.",
  evidence_files: ["src/api/users.ts", "src/lib/redis.ts"],
  tokens: 187,
  convention_count: 2,
};

let items: ConventionCandidate[];
let scan: ConventionScan;
let sent: { method: string; url: string; body: any }[];
/** Set to fail the conventions GET, for the error branch. */
let listStatus: number;

beforeEach(() => {
  items = [
    candidate(),
    candidate({
      id: "cv2",
      rule: "Redis access goes through the src/lib/redis.ts singleton.",
      evidence_path: "src/lib/redis.ts",
      evidence_snippet: "export const redis = new Redis(config.redisUrl);",
      confidence: 0.85,
    }),
    candidate({
      id: "cv3",
      rule: "All public route handlers return a typed Result<T, ApiError>.",
      evidence_path: "src/api/public/index.ts",
      evidence_snippet: "function handler(): Result<Item[], ApiError> {",
      confidence: 0.78,
    }),
  ];
  scan = { ...SCAN };
  sent = [];
  listStatus = 200;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method !== "GET") sent.push({ method, url, body });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });

      // The app shell resolves the active repo from here; without it
      // useRepoNotFound renders RepoNotFound instead of the page.
      if (method === "GET" && url.endsWith("/repos")) return json([REPO]);
      // Once a repo resolves, the shell reads its PRs for the sidebar badge. It
      // filters the response, so this has to be an array — the catch-all object
      // below would throw inside the shell and blank the whole render.
      if (method === "GET" && url.endsWith("/pulls")) return json([]);

      if (method === "GET" && url.endsWith("/conventions/skill-draft")) return json(DRAFT);

      if (method === "GET" && url.endsWith("/conventions")) {
        if (listStatus !== 200) {
          return json({ error: { code: "boom", message: "Server exploded" } }, listStatus);
        }
        return json({ scan, items });
      }

      if (method === "POST" && url.endsWith("/conventions/scan")) {
        scan = { ...scan, status: "running" };
        return json({ status: "accepted", jobId: "job-1" }, 202);
      }

      if (method === "POST" && url.endsWith("/conventions/status")) {
        const ids: string[] = body.ids;
        items = items.map((c) => (ids.includes(c.id) ? { ...c, status: body.status } : c));
        return json(items.filter((c) => ids.includes(c.id)));
      }

      if (method === "PATCH" && url.includes("/conventions/")) {
        const id = url.split("/").pop()!;
        items = items.map((c) =>
          c.id === id
            ? { ...c, ...body, edited: body.rule !== undefined ? true : c.edited }
            : c,
        );
        return json(items.find((c) => c.id === id));
      }

      if (method === "POST" && url.endsWith("/skills")) {
        return json({ id: "sk9", version: 1, enabled: true, ...body }, 201);
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
        messages={{ conventions: conventionMessages, shell: shellMessages }}
      >
        {/* RepoProvider resolves :repoId → the active repo, which is where the
            heading's repo name comes from. Without it the page still renders but
            falls back to the generic label, so the heading assertion would be
            testing the fallback rather than the real path. */}
        <RepoProvider>
          <ConventionsView />
        </RepoProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("ConventionsView", () => {
  it("renders a card per convention with its evidence and confidence", async () => {
    renderView();
    expect(
      await screen.findByText("Always use async/await instead of .then() chains."),
    ).toBeInTheDocument();
    expect(screen.getByText("src/api/users.ts")).toBeInTheDocument();
    expect(screen.getByText("const user = await db.users.find(id);")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
  });

  it("heads the page with the repo name and what the scan sampled", async () => {
    renderView();
    expect(await screen.findByText("payments-api")).toBeInTheDocument();
    expect(screen.getByText(/Detected from 84 sample files/)).toBeInTheDocument();
  });

  it("tells the user to change model — not to retry — when the model can't do structured output", async () => {
    // "Re-scan to try again" is wrong advice here: no number of retries makes an
    // incapable model capable. The reason is what distinguishes the two.
    scan = { ...SCAN, status: "failed", reason: "model_unsupported" };
    renderView();
    expect(await screen.findByText(/can't produce structured output/)).toBeInTheDocument();
    expect(screen.queryByText(/Re-scan to try again/)).not.toBeInTheDocument();
  });

  it("still offers a retry for an ordinary scan failure", async () => {
    scan = { ...SCAN, status: "failed", reason: null };
    renderView();
    expect(await screen.findByText(/Re-scan to try again/)).toBeInTheDocument();
  });

  it("accepts a convention and MOVES the accepted counter", async () => {
    // The counter moving is what proves it derives from the server list. Held in
    // local state it could agree with the button and disagree with the data.
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    expect(screen.getByText("0 of 3 accepted")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", body: { status: "accepted" } });
    expect(sent[0]!.url).toContain("/conventions/cv1");
    expect(await screen.findByText("1 of 3 accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accepted" })).toBeInTheDocument();
  });

  it("rejects a convention, and it stops counting toward the skill", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");

    await user.click(screen.getAllByRole("button", { name: "Reject" })[0]!);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", body: { status: "rejected" } });
    expect(await screen.findByRole("button", { name: "Rejected" })).toBeInTheDocument();
    expect(screen.getByText("0 of 3 accepted")).toBeInTheDocument();
  });

  it("edits a rule inline and sends only the new text", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");

    await user.click(screen.getAllByRole("button", { name: "Edit this rule" })[0]!);
    const input = screen.getByLabelText("Convention rule");
    await user.clear(input);
    await user.type(input, "Prefer async/await.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", body: { rule: "Prefer async/await." } });
    expect(await screen.findByText("Prefer async/await.")).toBeInTheDocument();
  });

  it("cancelling an edit writes nothing", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");

    await user.click(screen.getAllByRole("button", { name: "Edit this rule" })[0]!);
    await user.type(screen.getByLabelText("Convention rule"), " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(sent).toHaveLength(0);
    expect(
      screen.getByText("Always use async/await instead of .then() chains."),
    ).toBeInTheDocument();
  });

  it("gates Create skill on at least one accepted convention", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");

    expect(screen.getByRole("button", { name: /Create skill/ })).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create skill/ })).toBeEnabled(),
    );
  });

  it("opening the modal composes a draft and WRITES NOTHING", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    await user.click(screen.getByRole("button", { name: /Create skill/ }));

    const dialog = await screen.findByRole("dialog");
    // Prefilled from the draft…
    expect(within(dialog).getByDisplayValue("payments-api-conventions")).toBeInTheDocument();
    expect(
      within(dialog).getByDisplayValue("2 house conventions extracted from payments-api"),
    ).toBeInTheDocument();
    // …the body is shown line-numbered…
    expect(within(dialog).getByText("# payments-api-conventions")).toBeInTheDocument();
    expect(within(dialog).getByText("187 tokens")).toBeInTheDocument();
    // …and nothing has been written.
    expect(sent).toHaveLength(0);
  });

  it("saves the EDITED body, with the extracted origin and its evidence files", async () => {
    // Proves the draft is a suggestion the user owns, not a server-authored save.
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    await user.click(screen.getByRole("button", { name: /Create skill/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Edit the skill body" }));
    const body = within(dialog).getByLabelText("Skill body (Markdown)");
    await user.clear(body);
    await user.type(body, "# edited by hand");
    // The token count becomes an estimate once the text diverges from the server's.
    expect(within(dialog).getByText(/^~/)).toBeInTheDocument();
    expect(within(dialog).getByText("unsaved")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Create skill/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: {
        name: "payments-api-conventions",
        type: "convention",
        source: "extracted",
        enabled: true,
        body: "# edited by hand",
        evidence_files: ["src/api/users.ts", "src/lib/redis.ts"],
      },
    });
  });

  it("closes the modal on Escape without writing", async () => {
    // `Modal` handles neither Escape nor focus; only our own effect makes this work.
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    await user.click(screen.getByRole("button", { name: /Create skill/ }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
  });

  it("clears every accepted convention in ONE request", async () => {
    // N parallel PATCHes would stack N toasts on a partial failure.
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(screen.getByText("2 of 3 accepted")).toBeInTheDocument());
    sent.length = 0;

    await user.click(screen.getByRole("button", { name: /Deselect all/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: { ids: ["cv1", "cv2"], status: "pending" },
    });
    expect(await screen.findByText("0 of 3 accepted")).toBeInTheDocument();
  });

  it("re-scans, and an accepted card stays accepted afterwards", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Always use async/await instead of .then() chains.");
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await waitFor(() => expect(screen.getByText("1 of 3 accepted")).toBeInTheDocument());
    sent.length = 0;

    await user.click(screen.getByRole("button", { name: /Re-scan/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url).toContain("/conventions/scan");
    // Decisions survive a re-scan — the cache is invalidated, never dropped.
    expect(screen.getByRole("button", { name: "Accepted" })).toBeInTheDocument();
  });

  it("shows an inline error with a retry when the list fails to load", async () => {
    listStatus = 500;
    renderView();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load conventions.")).toBeInTheDocument();
  });

  it("offers to run an extraction when nothing has been found yet", async () => {
    items = [];
    scan = { ...SCAN, status: "idle", sample_files: 0, candidates_found: 0 };
    const user = userEvent.setup();
    renderView();

    expect(await screen.findByText("No conventions extracted yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Run extraction/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain("/conventions/scan");
  });
});
