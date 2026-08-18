#!/usr/bin/env bash
#
# Contract mirror guard — `@devdigest/shared` exists twice on purpose:
#
#   server/src/vendor/shared/   CANONICAL — the wire format the API actually serves
#   client/src/vendor/shared/   a hand-synced copy the studio's types are built from
#
# There is no build step tying them together, so the copy can silently fall
# behind. When it does, the client's types quietly disagree with the wire
# format and `tsc` still passes on both sides — the failure only shows up at
# runtime as a Zod parse error or a field that is always undefined.
#
# This script fails when the two trees differ. Run it locally before pushing a
# contract change; CI runs it on every PR (.github/workflows/contracts.yml).
#
#   ./scripts/check-contracts.sh          # check only, exits 1 on drift
#   ./scripts/check-contracts.sh --fix    # copy canonical → client, then check
#
# Fixing is always one-directional: server wins. If the client genuinely needs
# a shape the server does not serve, that shape does not belong in `shared`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL="$ROOT/server/src/vendor/shared"
MIRROR="$ROOT/client/src/vendor/shared"

for d in "$CANONICAL" "$MIRROR"; do
  [ -d "$d" ] || { echo "check-contracts: missing directory: $d" >&2; exit 2; }
done

if [ "${1:-}" = "--fix" ]; then
  echo "check-contracts: syncing $CANONICAL → $MIRROR"
  # --delete so a file removed from the canonical copy is removed here too.
  rsync -a --delete "$CANONICAL/" "$MIRROR/"
  echo "check-contracts: synced. Review the diff and typecheck the client:"
  echo "  git diff -- client/src/vendor/shared && (cd client && pnpm typecheck)"
fi

if diff -r "$CANONICAL" "$MIRROR" > /tmp/devdigest-contract-drift.txt 2>&1; then
  echo "check-contracts: OK — client mirror matches the canonical contracts."
  exit 0
fi

cat >&2 <<EOF

check-contracts: FAILED — the client's copy of @devdigest/shared has drifted.

  canonical: server/src/vendor/shared/   (the wire format the API serves)
  mirror:    client/src/vendor/shared/   (what the studio's types believe)

Differences:

$(cat /tmp/devdigest-contract-drift.txt)

Fix with:

  ./scripts/check-contracts.sh --fix
  cd client && pnpm typecheck

If the client fails to typecheck after syncing, that is the real bug this
guard exists to surface — the UI was written against a contract the API does
not serve.
EOF
exit 1
