// Entry point for stage 1: collect → route → run invariants → report.
//
// Writes .pr-self-review/{changeset.json,report.md} and prints a summary.
// It does NOT block anything yet — gate.sh and the PreToolUse hook land in
// stage 3. The verdict is computed and printed now so the severity model can
// be calibrated against real branches before it starts refusing pushes.
//
//   node .claude/skills/pr-self-review/report.mjs          # human summary
//   node .claude/skills/pr-self-review/report.mjs --json    # machine readable

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect } from './collect.mjs';
import { routeAll, installedSkills } from './routing.mjs';
import { runInvariants } from './invariants.mjs';
import { REPO_ROOT, SEVERITY_ORDER } from './lib.mjs';

const OUT_DIR = join(REPO_ROOT, '.pr-self-review');

function tally(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

function buildMarkdown({ changeset, coverage, findings, counts, verdict }) {
  const L = [];
  const { base, files, excluded } = changeset;

  L.push('# PR self-review — stage 1 (deterministic)');
  L.push('');
  L.push(`- branch **${base.branch}** → base **${base.ref}** \`${base.sha.slice(0, 8)}\``);
  L.push(`- **${files.length}** files under review, ${excluded.length} excluded as generated`);
  L.push(`- verdict: **${verdict}** — ${counts.critical} critical, ${counts.major} major, ${counts.info} info`);
  L.push('');
  L.push('> Stage 1 runs the deterministic half only: repo invariants and skill');
  L.push('> routing. Skill-driven review of the diff arrives in stage 2.');
  L.push('');

  L.push('## Invariant findings');
  L.push('');
  if (findings.length === 0) {
    L.push('None. Every repo invariant holds for this changeset.');
  } else {
    L.push('| severity | check | file | what |');
    L.push('|---|---|---|---|');
    for (const f of findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      L.push(`| ${f.severity} | \`${f.id}\` | \`${where}\` | ${f.message}<br>→ ${f.fix} |`);
    }
  }
  L.push('');

  L.push('## Skill coverage');
  L.push('');
  L.push('Which skill will review which files in stage 2.');
  L.push('');
  L.push('| skill | files |');
  L.push('|---|---|');
  for (const { skill, count } of coverage.bySkill) L.push(`| \`${skill}\` | ${count} |`);
  L.push('');

  if (coverage.missingSkills.length > 0) {
    L.push(
      `⚠️ routing points at skills that are not installed: ${coverage.missingSkills
        .map((s) => `\`${s}\``)
        .join(', ')}`,
    );
    L.push('');
  }

  L.push('### Files with no domain skill');
  L.push('');
  L.push('Matched only the catch-all rules (`typescript-expert`, `security`).');
  L.push('Not an error — a prompt to grow `routing.mjs` when a pattern recurs.');
  L.push('');
  if (coverage.uncovered.length === 0) {
    L.push('None.');
  } else {
    for (const p of coverage.uncovered) L.push(`- \`${p}\``);
  }
  L.push('');

  if (coverage.checks.length > 0) {
    L.push('## Extra checks required by the changeset');
    L.push('');
    for (const c of coverage.checks) L.push(`- \`${c}\``);
    L.push('');
  }

  const packages = [...new Set(files.map((f) => f.package))].filter((p) => p !== 'root');
  if (packages.length > 0) {
    L.push('## Suggested package commands');
    L.push('');
    for (const p of packages) {
      const pm = p === 'server' || p === 'client' ? 'pnpm' : 'npm run';
      L.push(`- \`cd ${p} && ${pm} typecheck && ${pm === 'pnpm' ? 'pnpm' : 'npm'} test\``);
    }
    if (packages.includes('server')) L.push('- `cd server && pnpm lint:arch`');
    L.push('');
  }

  return L.join('\n');
}

function main() {
  const changeset = collect();
  const coverage = routeAll(changeset.files);
  const findings = runInvariants(changeset);
  const counts = tally(findings);
  const verdict = counts.critical > 0 ? 'fail' : 'pass';

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedFor: { headSha: changeset.headSha, base: changeset.base },
    verdict,
    counts,
    findings,
    coverage: {
      bySkill: coverage.bySkill,
      uncovered: coverage.uncovered,
      missingSkills: coverage.missingSkills,
      checks: coverage.checks,
    },
    files: coverage.files,
    excluded: changeset.excluded,
  };
  writeFileSync(join(OUT_DIR, 'changeset.json'), JSON.stringify(payload, null, 2));

  const md = buildMarkdown({ changeset, coverage, findings, counts, verdict });
  writeFileSync(join(OUT_DIR, 'report.md'), `${md}\n`);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(md);
  console.log(`\nWritten: .pr-self-review/report.md, .pr-self-review/changeset.json`);
  const installed = installedSkills();
  const unused = [...installed].filter((s) => !coverage.bySkill.some((b) => b.skill === s));
  if (unused.length > 0) {
    console.log(`Skills not triggered by this changeset: ${unused.join(', ')}`);
  }
}

main();
