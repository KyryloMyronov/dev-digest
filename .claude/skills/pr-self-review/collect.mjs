// Phase 1 — collect the changeset.
//
// "Open changes" is everything not yet on the base branch, which is more than
// `git log` shows: committed work, staged work, unstaged work, and untracked
// files. A review that skips untracked files misses whole new modules — this
// repo has ~15 of them sitting untracked right now.

import { git, gitZ, contentHash, matchesAny, REPO_ROOT } from './lib.mjs';

/** Never reviewed. Generated output, scratch clones, our own report dir. */
export const EXCLUDED = [
  'server/clones/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.tsbuildinfo',
  '.pr-self-review/**',
  'pnpm-lock.yaml',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
];

const PACKAGES = ['server', 'client', 'reviewer-core', 'e2e'];

/**
 * Resolve the base commit to diff against.
 *
 * `origin/main` first (what the PR will actually target), then a local `main`,
 * then give up loudly — silently diffing against HEAD would report an empty
 * changeset and green-light everything.
 */
export function resolveBase() {
  const override = process.env.PR_SELF_REVIEW_BASE;
  const candidates = override ? [override] : ['origin/main', 'main'];

  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { soft: true })) {
      const mergeBase = git(['merge-base', ref, 'HEAD'], { soft: true });
      if (mergeBase) return { ref, sha: mergeBase.trim() };
    }
  }

  throw new Error(
    `no base branch found (tried ${candidates.join(', ')}). ` +
      'Set PR_SELF_REVIEW_BASE to the ref this branch will be merged into.',
  );
}

/**
 * Parse `git diff --name-status -z`. With -z the stream is
 * `status\0path\0` per entry, except renames/copies which are
 * `R100\0old\0new\0`. Splitting on newlines instead of NUL is the classic way
 * to break on paths with spaces.
 */
function parseNameStatus(tokens) {
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (/^[RC]/.test(status)) {
      entries.push({ path: tokens[i + 2], status: status[0], from: tokens[i + 1] });
      i += 3;
    } else {
      entries.push({ path: tokens[i + 1], status: status[0] });
      i += 2;
    }
  }
  return entries;
}

function packageOf(path) {
  const first = path.split('/')[0];
  return PACKAGES.includes(first) ? first : 'root';
}

export function collect() {
  const base = resolveBase();

  // One call covers committed + staged + unstaged: `git diff <commit>` is
  // commit-vs-working-tree, not commit-vs-HEAD.
  const tracked = parseNameStatus(gitZ(['diff', '--name-status', '-z', '-M', base.sha]));
  const untracked = gitZ(['ls-files', '--others', '--exclude-standard', '-z']).map((path) => ({
    path,
    status: 'A',
    untracked: true,
  }));

  const seen = new Map();
  for (const entry of [...tracked, ...untracked]) {
    seen.set(entry.path, { ...seen.get(entry.path), ...entry });
  }

  const files = [];
  const excluded = [];
  for (const entry of [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const record = {
      path: entry.path,
      status: entry.status,
      untracked: Boolean(entry.untracked),
      package: packageOf(entry.path),
      hash: entry.status === 'D' ? null : contentHash(entry.path),
      ...(entry.from ? { from: entry.from } : {}),
    };
    if (matchesAny(entry.path, EXCLUDED)) excluded.push(record);
    else files.push(record);
  }

  return {
    repoRoot: REPO_ROOT,
    base: { ...base, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() },
    headSha: git(['rev-parse', 'HEAD']).trim(),
    files,
    excluded,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(collect(), null, 2));
}
