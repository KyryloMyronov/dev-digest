#!/usr/bin/env node
// Gathers a dependency inventory across DevDigest's five standalone packages
// and emits it as JSON. Does no formatting/prose — that's the caller's job
// (see SKILL.md). Safe to run repeatedly; touches nothing on disk.
//
// Usage:
//   node scan.mjs [--root <repo-root>] [--skip-outdated]
//
// --skip-outdated avoids shelling out to `pnpm outdated` / `npm outdated`,
// which hit the registry and can be slow or fail offline.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const rootFlagIdx = args.indexOf('--root');
const ROOT = rootFlagIdx >= 0 ? path.resolve(args[rootFlagIdx + 1]) : process.cwd();
const SKIP_OUTDATED = args.includes('--skip-outdated');

const PACKAGES = [
  { dir: 'server', manager: 'pnpm' },
  { dir: 'client', manager: 'pnpm' },
  { dir: 'reviewer-core', manager: 'npm' },
  { dir: 'mcp', manager: 'npm' },
  { dir: 'e2e', manager: 'npm' },
];

function sh(cmd, cmdArgs, cwd) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  } catch (e) {
    // Both `npm outdated` and `pnpm outdated` exit non-zero when they find
    // anything to report, but still write valid JSON to stdout — recover it.
    return e.stdout ? e.stdout.toString() : '';
  }
}

// -L: follow symlinks, so a pnpm top-level symlink into node_modules/.pnpm
// resolves to the real content size instead of ~0 bytes for the link itself.
function duKb(targetPath, followSymlinks) {
  if (!existsSync(targetPath)) return null;
  const flags = followSymlinks ? ['-sk', '-L'] : ['-sk'];
  const out = sh('du', [...flags, targetPath]);
  const kb = parseInt(out.trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? kb : null;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function depEntries(pkgJson) {
  const kinds = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
  ];
  const out = [];
  for (const [field, kind] of kinds) {
    for (const [name, range] of Object.entries(pkgJson[field] || {})) {
      out.push({ name, range, kind });
    }
  }
  return out;
}

function outdated(dir, manager) {
  if (SKIP_OUTDATED) return { skipped: true };
  try {
    if (manager === 'pnpm') {
      const out = sh('pnpm', ['outdated', '--format', 'json'], dir);
      return { data: out ? JSON.parse(out) : {} };
    }
    const out = sh('npm', ['outdated', '--json'], dir);
    return { data: out ? JSON.parse(out) : {} };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  packages: {},
};

for (const { dir: pkgDir, manager } of PACKAGES) {
  const dir = path.join(ROOT, pkgDir);
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    report.packages[pkgDir] = { missing: true };
    continue;
  }
  const pkgJson = readJson(pkgJsonPath);
  const nmDir = path.join(dir, 'node_modules');
  const nmExists = existsSync(nmDir);

  const deps = depEntries(pkgJson).map(({ name, range, kind }) => {
    const depDir = path.join(nmDir, ...name.split('/'));
    const installed = nmExists && existsSync(depDir);
    let version = null;
    if (installed) {
      try {
        version = readJson(path.join(depDir, 'package.json')).version;
      } catch {
        /* malformed or missing nested package.json — leave version null */
      }
    }
    const sizeKb = installed ? duKb(depDir, true) : null;
    return { name, range, kind, installed, version, sizeKb };
  });

  const attributedKb = deps.reduce((sum, d) => sum + (d.sizeKb || 0), 0);

  report.packages[pkgDir] = {
    packageName: pkgJson.name,
    manager,
    nodeModulesExists: nmExists,
    totalNodeModulesKb: nmExists ? duKb(nmDir, false) : null,
    attributedDepsKb: attributedKb,
    deps,
    outdated: outdated(dir, manager),
  };
}

// Cross-package: same dependency name declared/installed in more than one
// package, with the installed versions side by side.
const byDep = {};
for (const [pkgDir, info] of Object.entries(report.packages)) {
  if (info.missing) continue;
  for (const d of info.deps) {
    if (!d.installed) continue;
    (byDep[d.name] ??= []).push({ package: pkgDir, range: d.range, version: d.version, kind: d.kind });
  }
}
report.crossPackage = Object.entries(byDep)
  .filter(([, occurrences]) => occurrences.length > 1)
  .map(([name, occurrences]) => {
    const majors = new Set(occurrences.map((o) => (o.version || '').split('.')[0]));
    return { name, occurrences, majorDrift: majors.size > 1 };
  })
  .sort((a, b) => Number(b.majorDrift) - Number(a.majorDrift) || b.occurrences.length - a.occurrences.length);

// Largest direct dependencies across the whole repo, for the "what's heavy" view.
report.topDepsBySize = Object.entries(report.packages)
  .flatMap(([pkgDir, info]) => (info.missing ? [] : info.deps.map((d) => ({ package: pkgDir, ...d }))))
  .filter((d) => d.sizeKb != null)
  .sort((a, b) => b.sizeKb - a.sizeKb)
  .slice(0, 20);

process.stdout.write(JSON.stringify(report, null, 2));
