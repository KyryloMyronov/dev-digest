/**
 * project-context — run-start resolution (SPEC-01 Cut 2).
 *
 * AC-21/22 decide WHICH documents a run injects and in what order; AC-40/43/45/
 * 48/49 decide which of them survive reading, the per-document size cap, the
 * token budget and the wall-clock timeout. `run-executor` never sees any of
 * that: it receives a `ResolvedContext` and spreads `texts` into the engine's
 * `specs` slot.
 *
 * ─── THE GOVERNING PRINCIPLE ────────────────────────────────────────────────
 * **The context layer must never fail a review.** Inherited verbatim from
 * `buildSkillBlocks` (`modules/reviews/run-executor.ts`): failing a whole run
 * over the grounding layer is worse than reviewing without it. Every failure
 * here degrades to a shorter list (plus an injected log line when the caller
 * supplied one) — AC-47 (resolution throws) and AC-48 (resolution slow) are
 * satisfied INSIDE this file, which is why `run-executor` needs no try/catch of
 * its own.
 *
 * ─── WHY THERE IS NO WALK HERE ──────────────────────────────────────────────
 * The paths this file reads are the PERSISTED `agent_context_docs.path` /
 * `skill_context_docs.path` values, and it does NOT re-validate them against a
 * fresh walk of the clone. That is deliberate and it was decided at review, not
 * overlooked: `SimpleGitClient.readFile`'s containment guard is LEXICAL, so a
 * symlink inside the clone pointing out of it is "contained". Membership
 * filtering therefore happens ONCE, at the attach route (step 22), rather than
 * once per document per run — a full walk on the critical path of every LLM call
 * would spend NFR-1's budget on work the door already did. The two declined
 * alternatives were re-validating here and switching the adapter guard to
 * `realpath`.
 *
 * The ONE thing that check cannot cover is bought back below: the attach check
 * is a time-of-check and this file's read is the time-of-use, and a repository
 * owner can swap what an attached path POINTS AT between the two (the clone
 * hard-resets on `resync`, and re-attaching is exempt from the door's check).
 * So every document is checked for REAL containment here, with `realpath`:
 * `realpath` resolves every component, which is what makes this a class of
 * vector rather than one instance of it — `lstat` + `isSymbolicLink()` alone
 * (this file's first attempt) does not follow the FINAL component but does
 * follow every intermediate one, so replacing an attached `specs/sub/foo.md`'s
 * `specs/sub` directory with a link out of the clone defeated it while staying
 * lexically inside. A document resolving outside the clone, or a symlink at
 * all, is skipped as `unread` (AC-43/AC-44) without being read — the same
 * degradation an unreadable file gets.
 *
 * This is NOT the declined adapter-level `realpath`: `SimpleGitClient.readFile`
 * is untouched, step 6 is not widened, and no caller outside this loop pays a
 * syscall. Two calls per document (`realpath` + the `lstat` AC-49 already
 * needed) against NFR-1's 250 ms — the timed test at the bottom of
 * `resolver.test.ts` prints the measurement.
 *
 * Dependencies arrive as narrow structural interfaces rather than concrete
 * classes so `resolver.test.ts` is hermetic (no Postgres, no clone) and so
 * nothing here imports another module's internals — `linkedSkills` is reached
 * through `container.agentsRepo`, whose shape is restated below as
 * `LinkedSkillsReader`.
 */
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { GitClient } from '@devdigest/shared';
import type { ResolvedContext, ContextSkipReason } from './types.js';
import type { ContextDocLinkRow } from './repository.js';
import {
  MAX_CONTEXT_DOCUMENT_BYTES,
  PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS,
  PROJECT_CONTEXT_TOKEN_BUDGET,
} from './constants.js';

/** What the resolver needs from `ProjectContextRepository`. */
export interface ContextLinkReader {
  agentDocs(workspaceId: string, agentId: string): Promise<ContextDocLinkRow[]>;
  docsForSkills(
    workspaceId: string,
    skillIds: string[],
  ): Promise<Map<string, ContextDocLinkRow[]>>;
}

/** One row of `container.agentsRepo.linkedSkills`, narrowed to what AC-21 uses. */
export interface LinkedSkillLike {
  skill: { id: string; name: string; enabled: boolean };
  order: number;
  /** The PER-AGENT switch (`agent_skills.enabled`). */
  enabled: boolean;
}

/**
 * `container.agentsRepo`, structurally. Restated here rather than imported:
 * `agents/repository.ts` is that module's private internal, and the container
 * is the sanctioned seam (`no-cross-module-internals`).
 */
export interface LinkedSkillsReader {
  linkedSkills(agentId: string): Promise<LinkedSkillLike[]>;
}

export interface ResolverDeps {
  links: ContextLinkReader;
  agents: LinkedSkillsReader;
  /** Reads go through the PORT, so step 6's containment guard is in force (AC-40). */
  git: Pick<GitClient, 'readFile' | 'clonePathFor'>;
  /** Injected so this file needs no tokenizer dependency; the caller memoises it. */
  countTokens: (text: string) => number;
  /** Live Log sink, when the caller has one (AC-44/46 are emitted by the caller). */
  onLog?: (msg: string) => void;
  /** Overridable only so the tests can observe the two ceilings at all. */
  limits?: { budgetTokens?: number; maxBytes?: number; timeoutMs?: number };
}

/** What ordering a list needs: the tenant and the agent. No repository. */
export interface PlanInput {
  workspaceId: string;
  agentId: string;
}

export interface ResolveInput extends PlanInput {
  repoOwner: string;
  repoName: string;
}

/** One candidate before it has been read: a path plus where it came from. */
export interface PlannedDoc {
  path: string;
  /** The skill's name when inherited, undefined when the agent attached it. */
  inheritedFrom?: string;
}

const EMPTY: ResolvedContext = { texts: [], injected: [], skipped: [] };

/**
 * AC-21 + AC-22 — the ordered, de-duplicated candidate list.
 *
 * Order: the agent's own attachments in their persisted order, then the
 * documents of its ACTIVE skills in skill order, each skill's own list in its
 * persisted order. A skill contributes only when BOTH switches are on
 * (`agent_skills.enabled` AND `skills.enabled`) — the same gate
 * `buildSkillBlocks` applies to skill bodies, so a muted skill cannot smuggle
 * documents into a prompt whose guidance block it is excluded from.
 *
 * Dedupe is applied AFTER concatenation and keeps the FIRST occurrence, so a
 * document the agent attached directly outranks the same document inherited
 * from a skill, and its `inherited_from` label does not appear.
 *
 * Exported for two callers: `resolver.test.ts` (AC-21 and AC-22 are about order,
 * and order is observable here with no file system at all) and the service's
 * agent-attachment listing, so the Context tab shows exactly the rows — in
 * exactly the order — that a run would inject.
 */
export async function planContextDocs(
  deps: Pick<ResolverDeps, 'links' | 'agents'>,
  input: PlanInput,
): Promise<PlannedDoc[]> {
  const own = await deps.links.agentDocs(input.workspaceId, input.agentId);
  const candidates: PlannedDoc[] = own.map((d) => ({ path: d.path }));

  const links = await deps.agents.linkedSkills(input.agentId);
  const active = links.filter((l) => l.enabled && l.skill.enabled);
  if (active.length > 0) {
    const bySkill = await deps.links.docsForSkills(
      input.workspaceId,
      active.map((l) => l.skill.id),
    );
    for (const link of active) {
      for (const doc of bySkill.get(link.skill.id) ?? []) {
        candidates.push({ path: doc.path, inheritedFrom: link.skill.name });
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/**
 * Resolve, read and filter one run's project context. **Never throws**, never
 * rejects, and never runs longer than the timeout.
 *
 * AC-48's timeout wraps the WHOLE resolve-and-read pass rather than each read,
 * and partial work is discarded on expiry: a prompt assembled from "the first
 * three documents that happened to be fast" is not reproducible, and the run
 * being byte-identical to the no-context baseline is what makes a with/without
 * comparison mean anything (AC-50).
 */
export async function resolveContextForRun(
  deps: ResolverDeps,
  input: ResolveInput,
): Promise<ResolvedContext> {
  const timeoutMs = deps.limits?.timeoutMs ?? PROJECT_CONTEXT_RESOLVE_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs);
    // Never hold the process (or a test run) open on this timer.
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([readPass(deps, input), expiry]);
    if (outcome === 'timeout') {
      deps.onLog?.(
        `project context: resolution exceeded ${timeoutMs}ms — reviewing without it`,
      );
      return EMPTY;
    }
    return outcome;
  } catch (err) {
    // AC-47 — a throwing lookup, a vanished clone, a broken tokenizer: all the
    // same answer. The review runs, with no project context.
    deps.onLog?.(
      `project context: resolution failed, reviewing without it — ${(err as Error).message}`,
    );
    return EMPTY;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The resolve-and-read pass the timeout races. May throw; the caller absorbs it. */
async function readPass(deps: ResolverDeps, input: ResolveInput): Promise<ResolvedContext> {
  const budget = deps.limits?.budgetTokens ?? PROJECT_CONTEXT_TOKEN_BUDGET;
  const maxBytes = deps.limits?.maxBytes ?? MAX_CONTEXT_DOCUMENT_BYTES;

  const planned = await planContextDocs(deps, input);
  if (planned.length === 0) return EMPTY;

  const ref = { owner: input.repoOwner, name: input.repoName };
  const root = resolve(deps.git.clonePathFor(ref));
  // The ROOT is resolved too, once per pass: on macOS the clone dir routinely
  // sits under a symlinked prefix (`/var` -> `/private/var`), so comparing a
  // resolved document against an UNresolved root would reject every document.
  // Falls back to the lexical root when the clone directory does not resolve.
  const realRoot = (await realpathOf(root)) ?? root;

  const texts: string[] = [];
  const injected: string[] = [];
  const skipped: { path: string; reason: ContextSkipReason }[] = [];

  let used = 0;
  let budgetReached = false;

  for (const doc of planned) {
    // AC-45 — once the ceiling is hit we STOP adding; every remaining candidate
    // is reported as `budget` without being read, because reading it could not
    // change the outcome.
    if (budgetReached) {
      skipped.push({ path: doc.path, reason: 'budget' });
      continue;
    }

    const full = resolve(join(root, doc.path));
    // The same lexical containment the adapter applies, repeated here only so
    // the `stat` below cannot touch a file outside the clone. This is NOT a
    // membership check and is not a walk — see the header.
    if (full !== root && !full.startsWith(root + sep)) {
      skipped.push({ path: doc.path, reason: 'unread' });
      continue;
    }

    // AC-43 — REAL containment, and the reason this loop is safe at all: every
    // component is resolved, so a symlink anywhere in the path (the file itself
    // OR a parent directory swapped in after the attach check) is caught. A
    // document that RESOLVES OUTSIDE the clone is never read: same `unread`
    // entry, same Live Log line as an unreadable file.
    //
    // A path that does not resolve at all is NOT skipped here — it falls
    // through and the read decides, which is the same contract `lstatOf` has
    // always had. Two reasons: an unresolvable path cannot leak a byte (a real
    // read of it fails too, and that failure is already reported as `unread`),
    // and a virtual `GitClient` — the mock the review suites inject — serves
    // documents with no clone on disk at all, where every `realpath` fails.
    const real = await realpathOf(full);
    if (real !== null && real !== realRoot && !real.startsWith(realRoot + sep)) {
      skipped.push({ path: doc.path, reason: 'unread' });
      continue;
    }

    // AC-49 — the size cap is checked BEFORE the read, so a 400 KB+ document
    // never occupies memory on the review path. `lstat` on the ATTACHED path,
    // not `stat`: it also keeps the resolver's idea of a document identical to
    // the attach-time walk's, which never emits a symlink (`walk.ts:118`), so a
    // link is skipped even when it points back INSIDE the clone.
    const stats = await lstatOf(full);
    if (stats?.isSymbolicLink()) {
      skipped.push({ path: doc.path, reason: 'unread' });
      continue;
    }

    if (stats !== null && stats.size > maxBytes) {
      skipped.push({ path: doc.path, reason: 'oversize' });
      continue;
    }

    let text: string;
    try {
      // AC-40 — through the port, so the containment guard applies on the run
      // path too. A missing file, a deleted clone or an escaping path all land
      // here as `unread` (AC-43).
      text = await deps.git.readFile(ref, doc.path);
    } catch {
      skipped.push({ path: doc.path, reason: 'unread' });
      continue;
    }

    const tokens = countSafely(deps, text);
    if (used + tokens > budget) {
      budgetReached = true;
      skipped.push({ path: doc.path, reason: 'budget' });
      continue;
    }

    texts.push(text);
    injected.push(doc.path);
    used += tokens;
  }

  return { texts, injected, skipped };
}

/**
 * A tokenizer failure must not lose the run's context, only its precision —
 * same posture as the token-count job's AC-37 fallback. A zero would let an
 * unbounded amount of text past the budget, so the estimate is char-based.
 */
function countSafely(deps: ResolverDeps, text: string): number {
  try {
    return deps.countTokens(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Where the path REALLY lands, with every component resolved, or `null` when it
 * cannot be resolved at all (a missing file, a broken link, a clone that is not
 * on this disk because the `GitClient` is virtual). `null` means "unknown", not
 * "outside" — see the call site for why that is the safe reading.
 */
async function realpathOf(fullPath: string): Promise<string | null> {
  try {
    return await realpath(fullPath);
  } catch {
    return null;
  }
}

/**
 * The size for AC-49 and the link bit for AC-43. `lstat` describes the entry
 * itself rather than what it points at, which is the whole point — a `stat`
 * here would report the target's size and hide the link entirely.
 */
async function lstatOf(fullPath: string): Promise<Stats | null> {
  try {
    return await lstat(fullPath);
  } catch {
    // Unstattable: let the read decide, and report it as `unread` when it fails.
    return null;
  }
}
