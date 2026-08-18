// Phase 3b — this repo's own invariants.
//
// The vendored skills know React and Fastify. They do not know that every
// domain table carries workspace_id, that `@devdigest/shared` exists twice, or
// that pnpm 11 refuses unapproved build scripts. Those are the rules that
// actually break this repo, and all of them are checkable without an LLM.
//
// Each check is deterministic and cheap. Rationale per check: repo-invariants.md.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addedLines, readRepoFile, matchesAny, bySeverity, REPO_ROOT } from './lib.mjs';

const finding = (id, severity, file, message, fix, extra = {}) => ({
  id,
  severity,
  file,
  message,
  fix,
  ...extra,
});

// --- 1. hash-locked skills -------------------------------------------------
// skills-lock.json is the machine-readable truth about what gets overwritten
// on sync. Skills authored in this repo are absent from it and are editable.
function lockedSkillEdited(files) {
  const lock = readRepoFile('skills-lock.json');
  if (!lock) return [];

  let locked;
  try {
    locked = Object.keys(JSON.parse(lock).skills ?? {});
  } catch {
    return [];
  }

  return files
    .filter((f) => locked.some((name) => matchesAny(f.path, [`.claude/skills/${name}/**`])))
    .map((f) =>
      finding(
        'locked-skill-edited',
        'critical',
        f.path,
        'edits a hash-locked skill — the next upstream sync overwrites this',
        'move the change into a skill authored here, or drop the skill from skills-lock.json first',
      ),
    );
}

// --- 2. shared contract mirror --------------------------------------------
// `@devdigest/shared` is canonical at server/src/vendor/shared/ and hand-copied
// to client/. Both packages type-check against their own copy, so drift only
// shows up at runtime as a Zod failure or a permanently-undefined field.
//
// Delegate to check-contracts.sh rather than reimplementing it. An earlier
// version of this check inferred drift from WHICH SIDE changed and produced
// five false positives on this very branch: the branch legitimately ran
// `--fix` to sync a mirror that was already stale on main, so only the client
// side appears in the diff while the trees agree perfectly. Only the end state
// matters, and one `diff -r` is the authority on it.
function contractMirrorDrift(files) {
  const touched = files.some(
    (f) =>
      f.path.startsWith('server/src/vendor/shared/') ||
      f.path.startsWith('client/src/vendor/shared/'),
  );
  if (!touched) return [];

  const script = join(REPO_ROOT, 'scripts/check-contracts.sh');
  if (!existsSync(script)) return [];

  try {
    execFileSync(script, [], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    return [];
  } catch (err) {
    const detail = String(err.stderr ?? '')
      .trim()
      .split('\n')
      .slice(0, 20)
      .join('\n');
    return [
      finding(
        'contract-mirror-drift',
        'critical',
        'client/src/vendor/shared/',
        'the client mirror of @devdigest/shared has drifted from the canonical copy',
        './scripts/check-contracts.sh --fix && (cd client && pnpm typecheck)',
        { detail },
      ),
    ];
  }
}

// --- 3. applied migrations -------------------------------------------------
// drizzle-kit output. A new .sql file is normal; modifying or deleting one that
// already ran leaves every existing database on a schema nobody can reproduce.
function migrationRewritten(files) {
  return files
    .filter(
      (f) =>
        f.path.startsWith('server/src/db/migrations/') &&
        f.path.endsWith('.sql') &&
        (f.status === 'M' || f.status === 'D'),
    )
    .map((f) =>
      finding(
        'migration-rewritten',
        'critical',
        f.path,
        `${f.status === 'D' ? 'deletes' : 'modifies'} a migration that may already be applied`,
        'revert it and add a new migration with `cd server && pnpm db:generate`',
      ),
    );
}

// --- 4. workspace scoping --------------------------------------------------
// "Every domain table carries workspace_id" is the repo's headline invariant,
// but it has a legitimate exception: child tables scope through a parent FK
// (pr_files → pull_requests → workspace). So a missing workspace_id with no FK
// at all is critical; with an FK it is only worth a look.
function tableWithoutWorkspaceScope(files, base) {
  const schemaFiles = files.filter(
    (f) =>
      (f.path === 'server/src/db/schema.ts' || f.path.startsWith('server/src/db/schema/')) &&
      f.status !== 'D',
  );

  const out = [];
  for (const f of schemaFiles) {
    const content = readRepoFile(f.path);
    if (!content) continue;
    const lines = content.split('\n');
    const added = new Set(addedLines(base, f.path, { untracked: f.untracked }).map((a) => a.line));

    for (let i = 0; i < lines.length; i++) {
      if (!/=\s*pgTable\(/.test(lines[i])) continue;
      if (!added.has(i + 1)) continue; // pre-existing table, not our business

      const block = balancedBlock(lines, i);
      const name = /pgTable\(\s*['"]([^'"]+)/.exec(block)?.[1] ?? 'unknown';
      if (/workspace_id/.test(block)) continue;

      const hasForeignKey = /\.references\(/.test(block);
      out.push(
        finding(
          'table-without-workspace-scope',
          hasForeignKey ? 'info' : 'critical',
          f.path,
          hasForeignKey
            ? `new table \`${name}\` has no workspace_id — confirm the parent FK really scopes it`
            : `new table \`${name}\` has neither workspace_id nor a foreign key — it is unscoped`,
          hasForeignKey
            ? 'if the parent is workspace-scoped this is fine (see pr_files); otherwise add workspace_id'
            : 'add a workspace_id column referencing workspaces.id',
          { line: i + 1 },
        ),
      );
    }
  }
  return out;
}

/** Text of a `pgTable(...)` call, by counting parens from its opening line. */
function balancedBlock(lines, startIdx) {
  let depth = 0;
  let opened = false;
  const collected = [];
  for (let i = startIdx; i < lines.length; i++) {
    collected.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '(') {
        depth++;
        opened = true;
      } else if (ch === ')') {
        depth--;
      }
    }
    if (opened && depth <= 0) break;
  }
  return collected.join('\n');
}

// --- 5. pnpm build scripts -------------------------------------------------
// pnpm 11 blocks a dependency's install scripts unless it is listed in that
// package's pnpm-workspace.yaml. Whether a new dep HAS install scripts is only
// knowable after install, so this is an advisory, not a verdict.
function newDependencyNeedsAllowBuilds(files, base) {
  const out = [];
  for (const pkg of ['server', 'client']) {
    const manifest = files.find((f) => f.path === `${pkg}/package.json`);
    if (!manifest) continue;

    // Intersect added lines with the real dependency names from the parsed
    // manifest. Matching `"key": "value"` on raw diff lines instead flagged
    // the `lint:arch` npm script as a new dependency.
    let depNames;
    try {
      const parsed = JSON.parse(readRepoFile(manifest.path) ?? '{}');
      depNames = new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
        ...Object.keys(parsed.optionalDependencies ?? {}),
      ]);
    } catch {
      continue;
    }

    const added = addedLines(base, manifest.path, { untracked: manifest.untracked })
      .map((a) => /^\s*"([^"]+)":\s*"[^"]*"/.exec(a.text)?.[1])
      .filter((name) => name && depNames.has(name));
    if (added.length === 0) continue;

    const ws = readRepoFile(`${pkg}/pnpm-workspace.yaml`) ?? '';
    const approved = [...ws.matchAll(/^\s{2}([\w@/.-]+):/gm)].map((m) => m[1]);
    const unlisted = added.filter((d) => !approved.includes(d));
    if (unlisted.length === 0) continue;

    out.push(
      finding(
        'dependency-may-need-allow-builds',
        'major',
        `${pkg}/package.json`,
        `new dependencies not in allowBuilds: ${unlisted.join(', ')}`,
        `if any runs an install script, add it to ${pkg}/pnpm-workspace.yaml — otherwise CI fails with ERR_PNPM_IGNORED_BUILDS`,
        { approved },
      ),
    );
  }
  return out;
}

// --- 6. secrets ------------------------------------------------------------
// Patterns are written so they cannot match their own source text.
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{20,}/, what: 'OpenAI-style API key' },
  { re: /ghp_[A-Za-z0-9]{36}/, what: 'GitHub personal access token' },
  { re: /github_pat_[A-Za-z0-9_]{40,}/, what: 'GitHub fine-grained token' },
  { re: /AKIA[0-9A-Z]{16}/, what: 'AWS access key id' },
  { re: /xox[baprs]-[0-9]{10,}/, what: 'Slack token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key' },
];

function secretsInChangeset(files, base) {
  const out = [];

  for (const f of files) {
    if (/(^|\/)\.env($|\.)/.test(f.path) && !/\.example$/.test(f.path) && f.status !== 'D') {
      out.push(
        finding(
          'env-file-committed',
          'critical',
          f.path,
          'an .env file is in the changeset',
          'remove it from the changeset; .gitignore already covers .env',
        ),
      );
      continue;
    }
    if (f.status === 'D') continue;

    for (const { line, text } of addedLines(base, f.path, { untracked: f.untracked })) {
      const hit = SECRET_PATTERNS.find((p) => p.re.test(text));
      if (!hit) continue;
      out.push(
        finding(
          'secret-in-diff',
          'critical',
          f.path,
          `looks like a committed ${hit.what}`,
          'remove it, rotate the credential, and load it from the environment instead',
          { line },
        ),
      );
      break; // one finding per file is enough to block
    }
  }
  return out;
}

// --- 7. stray artifacts ----------------------------------------------------
// The repo tracks zero images today (`git ls-files` over image extensions is
// empty), so anything binary in a changeset is a screenshot or scratch output
// that leaked in, until proven otherwise.
const ARTIFACT_EXT = /\.(png|jpe?g|gif|webp|bmp|pdf|zip|tgz|mov|mp4|log|heic)$/i;
const ARTIFACT_ALLOWED = ['client/public/**', '**/assets/**', '**/__fixtures__/**'];

function strayArtifacts(files) {
  return files
    .filter(
      (f) => f.status !== 'D' && ARTIFACT_EXT.test(f.path) && !matchesAny(f.path, ARTIFACT_ALLOWED),
    )
    .map((f) =>
      finding(
        'stray-artifact',
        'major',
        f.path,
        'binary/scratch file in the changeset — the repo tracks no images today',
        `delete it, or allow it explicitly (client/public/, assets/) if it belongs in the repo`,
      ),
    );
}

/**
 * The checks, keyed by the id used in repo-invariants.md. Exported so a
 * fixture test can drive them with synthetic changesets — a check that
 * silently stops firing is indistinguishable from a clean branch.
 */
export const CHECKS = {
  'locked-skill-edited': (files) => lockedSkillEdited(files),
  'contract-mirror-drift': (files) => contractMirrorDrift(files),
  'migration-rewritten': (files) => migrationRewritten(files),
  'table-without-workspace-scope': (files, base) => tableWithoutWorkspaceScope(files, base),
  'dependency-may-need-allow-builds': (files, base) => newDependencyNeedsAllowBuilds(files, base),
  'secret-in-diff': (files, base) => secretsInChangeset(files, base),
  'stray-artifact': (files) => strayArtifacts(files),
};

export function runInvariants(changeset) {
  const { files, base } = changeset;
  return Object.values(CHECKS)
    .flatMap((check) => check(files, base.sha))
    .sort(bySeverity);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { collect } = await import('./collect.mjs');
  console.log(JSON.stringify(runInvariants(collect()), null, 2));
}
