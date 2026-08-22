/**
 * Thin client for the DevDigest REST API. The API is the contract — this
 * package deliberately does NOT import `@devdigest/shared` (see
 * reviewer-core/insights.md: shared is aliased backwards into the server, so
 * importing it would chain this package to the server's source tree). The
 * types below are the minimal projections of the wire shapes the tools read.
 */

// Read per call, not at module load, so tests can point at a dead port.
const base = () => process.env.DEVDIGEST_API_URL ?? 'http://localhost:3001';

/** Error whose message is written for the model: short and actionable. */
export class ApiError extends Error {}

export interface Repo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
}

export interface PrMeta {
  id?: string | null;
  number: number;
  title: string;
  status: string;
}

export interface AgentDto {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  strategy: string;
  enabled: boolean;
  // system_prompt / output_schema exist on the wire but are never surfaced.
}

export interface RunSummary {
  run_id: string;
  agent_id: string | null;
  agent_name: string | null;
  status: string | null; // running | done | failed | cancelled
  error: string | null;
  findings_count: number | null;
  score: number | null;
  ran_at: string | null;
}

export interface FindingRecord {
  id: string;
  severity: 'CRITICAL' | 'WARNING' | 'SUGGESTION';
  category: string;
  title: string;
  file: string;
  start_line: number;
  end_line: number;
  rationale: string;
  suggestion?: string | null;
  confidence: number;
  accepted_at: string | null;
  dismissed_at: string | null;
}

export interface ReviewRecord {
  id: string;
  run_id: string | null;
  agent_name?: string | null;
  kind: 'summary' | 'review';
  verdict: string | null;
  summary: string | null;
  score: number | null;
  created_at: string;
  findings: FindingRecord[];
}

export interface ReviewRunTarget {
  run_id: string;
  agent_id: string;
  agent_name: string;
}

export interface ConventionCandidate {
  id: string;
  rule: string;
  evidence_path?: string | null;
  confidence?: number | null;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ConventionsView {
  scan: { status: string; reason?: string | null; finished_at?: string | null };
  items: ConventionCandidate[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      `DevDigest API is not reachable at ${base()}. Start the dev stack with ./scripts/dev.sh and retry.`,
    );
  }
  if (!res.ok) {
    // The server's error envelope is {error:{code,message}}; fall back to status text.
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      if (parsed?.error?.message) message = `${parsed.error.message} (${parsed.error.code ?? res.status})`;
    } catch {
      /* non-JSON body — keep the status line */
    }
    throw new ApiError(`DevDigest API error on ${method} ${path}: ${message}`);
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>('GET', path);
export const post = <T>(path: string, body: unknown) => request<T>('POST', path, body);

/**
 * Pure matcher: exact full_name, then exact name, then case-insensitive
 * substring of full_name. Exported for unit tests.
 */
export function matchRepo(repos: Repo[], ref: string): Repo | Repo[] {
  const exact = repos.filter((r) => r.full_name === ref);
  if (exact.length === 1) return exact[0];
  const byName = repos.filter((r) => r.name === ref);
  if (byName.length === 1) return byName[0];
  const needle = ref.toLowerCase();
  const fuzzy = repos.filter((r) => r.full_name.toLowerCase().includes(needle));
  return fuzzy.length === 1 ? fuzzy[0] : fuzzy;
}

export async function resolveRepo(ref: string): Promise<Repo> {
  const repos = await get<Repo[]>('/repos');
  const found = matchRepo(repos, ref);
  if (!Array.isArray(found)) return found;
  const known = repos.map((r) => r.full_name).join(', ') || '(none — add a repo in the studio first)';
  throw new ApiError(
    found.length === 0
      ? `Repo "${ref}" not found. Known repos: ${known}`
      : `Repo "${ref}" is ambiguous (${found.map((r) => r.full_name).join(', ')}). Use the full owner/name.`,
  );
}

export async function resolvePull(repoRef: string, prNumber: number): Promise<{ repo: Repo; pr: PrMeta }> {
  const repo = await resolveRepo(repoRef);
  const pulls = await get<PrMeta[]>(`/repos/${repo.id}/pulls`);
  const pr = pulls.find((p) => p.number === prNumber);
  if (!pr?.id) {
    const known = pulls.map((p) => `#${p.number}`).join(', ') || '(none synced yet)';
    throw new ApiError(`PR #${prNumber} not found in ${repo.full_name}. Known PRs: ${known}`);
  }
  return { repo, pr };
}
