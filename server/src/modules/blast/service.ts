import type { BlastCallerOut, BlastEndpointPath, BlastResponse, BlastStatus } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { Logger } from '../../platform/logger.js';
import { NotFoundError } from '../../platform/errors.js';
import type { DegradedReason } from '../repo-intel/types.js';

/**
 * L04 — Blast Radius service. A pure index read: everything comes from the
 * repo-intel facade (symbols / resolved references / file_rank / file_facts /
 * file_edges), no LLM and no GitHub round-trip, so it is safe to fetch on
 * every render of the Blast tab.
 *
 * Honesty over completeness: when the index can't answer, the response says so
 * via `status` + `reason` — empty arrays never stand in for missing data.
 */

/** Human text for the facade's DegradedReason codes. */
const DEGRADED_TEXT: Record<DegradedReason, string> = {
  flag_off: 'repo-intel is disabled (REPO_INTEL_ENABLED=false); results come from a best-effort scan without rank or endpoint data.',
  index_failed: 'the last index run failed; results come from a best-effort scan without rank or endpoint data.',
  index_partial: 'the index is partial; some callers and endpoints may be missing.',
  repo_too_large: 'the repository exceeds the index limits; results are incomplete.',
  no_data: 'the repository has not been indexed yet; results come from a best-effort scan without rank or endpoint data.',
};

export class BlastService {
  constructor(
    private container: Container,
    private log: Logger,
  ) {}

  async getBlast(workspaceId: string, prId: string): Promise<BlastResponse> {
    const pr = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pr) throw new NotFoundError('Pull request not found');

    const files = await this.container.pullsRepo.listFiles(pr.id);
    const changedFiles = files.map((f) => f.path);
    if (changedFiles.length === 0) {
      // Deliberately NOT importing from GitHub here (that is the pulls
      // module's job) — report the gap instead of masking it.
      return {
        status: 'degraded',
        reason: 'PR files are not synced yet — open the PR detail (GET /pulls/:id) to import them, then retry.',
        changed_files: [],
        impacts: [],
        endpoints: [],
      };
    }

    const repoIntel = this.container.repoIntel;
    const [state, blast, dependents] = await Promise.all([
      repoIntel.getIndexState(pr.repoId),
      repoIntel.getBlastRadius(pr.repoId, changedFiles),
      repoIntel.getDependents(pr.repoId, changedFiles),
    ]);

    // --- per-symbol impacts -------------------------------------------------
    const callersBySymbol = new Map<string, BlastCallerOut[]>();
    for (const c of blast.callers) {
      const row: BlastCallerOut = { file: c.file, symbol: c.symbol, line: c.line, rank: c.rank };
      const group = callersBySymbol.get(c.viaSymbol);
      if (group) group.push(row);
      else callersBySymbol.set(c.viaSymbol, [row]);
    }
    const truncated = new Set(blast.callersTruncatedFor ?? []);
    const impacts = blast.changedSymbols.map((s) => {
      const callers = callersBySymbol.get(s.name) ?? [];
      const endpoints = new Set<string>();
      const crons = new Set<string>();
      for (const c of callers) {
        const facts = blast.factsByFile?.[c.file];
        if (!facts) continue;
        for (const e of facts.endpoints) endpoints.add(e);
        for (const cr of facts.crons) crons.add(cr);
      }
      return {
        symbol: s.name,
        file: s.file,
        kind: s.kind,
        callers,
        callers_truncated: truncated.has(s.name),
        endpoints_affected: [...endpoints],
        crons_affected: [...crons],
      };
    });

    // --- endpoints via the reverse import graph (depth ≤ 2) ------------------
    // Direct caller files are depth-1 dependents by construction (a resolved
    // reference requires the import edge), so the walk subsumes their facts;
    // the factsByFile union below only fills persistent-path corner cases.
    const endpoints: BlastEndpointPath[] = [...dependents.endpointPaths];
    const seenEndpoint = new Set(endpoints.map((e) => `${e.endpoint}|${e.file}`));
    for (const [file, facts] of Object.entries(blast.factsByFile ?? {})) {
      for (const endpoint of facts.endpoints) {
        const key = `${endpoint}|${file}`;
        if (seenEndpoint.has(key)) continue;
        seenEndpoint.add(key);
        endpoints.push({ endpoint, file, chain: [file] });
      }
    }

    // --- status -------------------------------------------------------------
    let status: BlastStatus = 'full';
    let reason: string | undefined;
    if (blast.degraded || state.degraded) {
      status = 'degraded';
      const code = blast.reason ?? state.degradedReason ?? 'no_data';
      reason = `Blast radius is degraded: ${DEGRADED_TEXT[code]}`;
    } else if (state.status === 'partial') {
      status = 'partial';
      const skipped = state.filesSkipped > 0 ? ` (${state.filesSkipped} files skipped)` : '';
      const cause = state.reason ? ` — ${state.reason}` : '';
      reason = `The index is partial${skipped}${cause}; callers and endpoints may be incomplete.`;
    } else if (dependents.degraded) {
      // Blast answered from the index but the graph walk could not.
      status = 'partial';
      reason = `Endpoint paths are unavailable: ${DEGRADED_TEXT[dependents.reason ?? 'no_data']}`;
    }

    this.log.debug(
      { prId, status, symbols: impacts.length, endpoints: endpoints.length },
      'blast radius computed',
    );

    return {
      status,
      ...(reason !== undefined ? { reason } : {}),
      changed_files: changedFiles,
      impacts,
      endpoints,
    };
  }
}
