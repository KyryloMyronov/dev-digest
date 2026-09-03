/* hooks/keys.ts — the single source of truth for React Query cache keys.
 *
 * Keys used to be inline array literals repeated across hook files and, in a
 * couple of places, component files. Nothing tied a `useQuery(["reviews", id])`
 * to the `invalidateQueries(["reviews", id])` meant to refresh it, so a typo or
 * a rename silently produced a mutation that appeared to succeed while the UI
 * kept rendering stale data — no type error, no runtime error.
 *
 * Grouped by domain, mirroring one file per domain in this folder. Each group
 * exposes the broad key first and the specific ones under it, so
 * `invalidateQueries({ queryKey: reviewKeys.all })` still matches every
 * per-PR entry by prefix — the behaviour the old string literals relied on.
 *
 * `as const` throughout: it makes the tuples readonly and literal-typed, which
 * is what lets TypeScript catch a mistyped key at the call site.
 */

/**
 * An id embedded in a cache key. `number` is allowed because a PR is
 * addressable by its number as well as its uuid (`usePullDetail`), and
 * null/undefined because hooks stay mounted with a not-yet-resolved id and
 * gate the fetch on `enabled` instead.
 */
type Id = string | number | null | undefined;

// ---- Settings & secrets ----------------------------------------------------

export const settingsKeys = {
  all: ["settings"] as const,
};

export const secretsKeys = {
  status: ["secrets-status"] as const,
};

/** Provider model lists — queried per provider, invalidated as a whole. */
export const providerModelKeys = {
  all: ["provider-models"] as const,
  byProvider: (provider: Id) => ["provider-models", provider] as const,
};

// ---- Repos, pulls, context -------------------------------------------------

export const repoKeys = {
  all: ["repos"] as const,
};

export const pullKeys = {
  listByRepo: (repoId: Id) => ["pulls", repoId] as const,
  detail: (prId: Id) => ["pull", prId] as const,
  /** L03 · Smart Diff — the PR's files grouped by review role. Its own root, so
      it is never swept by an invalidation of the detail or the list. */
  smartDiff: (prId: Id) => ["pull-smart-diff", prId] as const,
  /** L04 · Blast Radius — its own root, like smartDiff: invalidate explicitly. */
  blast: (prId: Id) => ["pull-blast", prId] as const,
};

export const contextKeys = {
  /** The repo's discovered document list (ContextDocList). */
  byRepo: (repoId: Id) => ["context", repoId] as const,
  /** One document's text. Its own root, like pullKeys.smartDiff: it shares no
      prefix with `byRepo`, so a reindex invalidates the list by name and leaves
      cached bodies alone — the bodies did not change, only their token counts. */
  doc: (repoId: Id, path: string | null | undefined) =>
    ["context-doc", repoId, path] as const,
  /**
   * An agent's ordered attachments, INCLUDING the ones inherited from its
   * skills. Its own root: it shares no prefix with `byRepo`, so an attach must
   * invalidate both by name — the list's `attached_agents` count (AC-15) moves
   * when this does.
   */
  agentDocs: (agentId: Id, repoId: Id) => ["agent-context-docs", agentId, repoId] as const,
  /** A skill's ordered attachments. */
  skillDocs: (skillId: Id, repoId: Id) => ["skill-context-docs", skillId, repoId] as const,
};

export const repoIntelKeys = {
  state: (repoId: Id) => ["repo-intel-state", repoId] as const,
};

// ---- Agents ----------------------------------------------------------------

export const agentKeys = {
  all: ["agents"] as const,
  detail: (id: Id) => ["agent", id] as const,
  /** The agent's ordered skill links — invalidated by every attach/toggle/reorder. */
  skills: (id: Id) => ["agent-skills", id] as const,
  /**
   * SPEC-04 AC-96/AC-99 — the agent's `agent_versions` snapshots, newest first.
   * Its own root, like `contextKeys.doc`: a restore must invalidate this AND the
   * detail key explicitly, because the two share no prefix.
   */
  versions: (id: Id) => ["agent-versions", id] as const,
};

// ---- Eval (SPEC-04) --------------------------------------------------------

/**
 * SPEC-04. Read the TUPLES, not the header above: these prefixes deliberately
 * do NOT nest, so a mutation must invalidate the broad key and the specific one
 * EXPLICITLY (`client/insights.md` 2026-08-17). `useUpdateAgent`'s pairing is
 * the pattern to copy, not the comment at the top of this file.
 */
export const evalKeys = {
  /** The workspace dashboard — `GET /eval`. */
  workspace: ["eval-workspace"] as const,
  /** One agent's dashboard — `GET /eval/agents/:agentId`. */
  agent: (agentId: Id) => ["eval-agent", agentId] as const,
  /** An agent's eval cases — `GET /agents/:id/eval-cases`. */
  cases: (agentId: Id) => ["eval-cases", agentId] as const,
  /** One case — `GET /eval-cases/:id`. Its own root, like `contextKeys.doc`. */
  case: (caseId: Id) => ["eval-case", caseId] as const,
  /** An agent's batches — `GET /agents/:id/eval-runs`. The POLLED one (AC-66). */
  batches: (agentId: Id) => ["eval-batches", agentId] as const,
  /** The "run all agents" cost estimate — `GET /eval/estimate` (AC-72). */
  estimate: ["eval-estimate"] as const,
};

// ---- Skills ----------------------------------------------------------------

export const skillKeys = {
  all: ["skills"] as const,
  detail: (id: Id) => ["skill", id] as const,
  versions: (id: Id) => ["skill-versions", id] as const,
  /** Agents linking a skill — read before a delete, to name what it breaks. */
  agents: (id: Id) => ["skill-agents", id] as const,
};

// ---- Conventions -----------------------------------------------------------

export const conventionKeys = {
  all: ["conventions"] as const,
  /** The screen in one entry: `{ scan, items }` for a repo. */
  byRepo: (repoId: Id) => ["conventions", repoId] as const,
  /** The unsaved skill composed from the accepted rows. Read-only. */
  skillDraft: (repoId: Id) => ["convention-skill-draft", repoId] as const,
};

// ---- Reviews, runs, traces, comments ---------------------------------------

export const reviewKeys = {
  /** Every per-PR reviews list — `byPr` nests under it, so a prefix sweep works. */
  all: ["reviews"] as const,
  byPr: (prId: Id) => ["reviews", prId] as const,
};

/** L03 — the derived PR intent. Shares no prefix with reviewKeys/runKeys, so it
    must be invalidated explicitly by this exact key, never by a prefix sweep. */
export const intentKeys = {
  byPr: (prId: Id) => ["pr-intent", prId] as const,
};

/** SPEC-02 — the derived PR brief. Shares no prefix with reviewKeys/runKeys/
    intentKeys, so it must be invalidated by this exact key, never by a sweep. */
export const briefKeys = {
  byPr: (prId: Id) => ["pr-brief", prId] as const,
};

/** SPEC-03 — the PR's derived per-file summaries. Shares no prefix with
    pullKeys/reviewKeys/intentKeys/briefKeys, so it must be invalidated by this
    exact key, never by a prefix sweep. */
export const fileSummaryKeys = {
  byPr: (prId: Id) => ["pr-file-summaries", prId] as const,
};

export const runKeys = {
  byPr: (prId: Id) => ["pr-runs", prId] as const,
  activeByPr: (prId: Id) => ["pr-active-runs", prId] as const,
  trace: (runId: Id) => ["run-trace", runId] as const,
};

export const prCommentKeys = {
  byPr: (prId: Id) => ["pr-comments", prId] as const,
};
