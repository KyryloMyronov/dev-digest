#!/usr/bin/env bash
# Append-only guard for insights.md.
#
#   guard.sh snapshot <file>   run before touching the file
#   guard.sh verify   <file>   run after; non-zero exit means something was lost
#
# Invariant: the post-write file must differ from the pre-write file by ADDED
# lines only. Any removed or modified line fails, which catches a whole-file
# overwrite, a dropped entry, and a "helpful" reflow of an existing line alike.
set -uo pipefail

usage() {
  printf 'usage: guard.sh snapshot|verify <file>\n' >&2
  exit 2
}

[ $# -eq 2 ] || usage
mode=$1
file=$2
[ -f "$file" ] || { printf 'FAIL: no such file: %s\n' "$file" >&2; exit 2; }

# Normalise so a relative and an absolute path map to the same snapshot.
abs=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")
snap="${TMPDIR:-/tmp}/insights-guard/$(printf '%s' "$abs" | tr '/' '_').snap"

# A file with no final newline gains one as soon as anything is appended after
# its last line. That is a legitimate append, not a loss, so normalise both
# sides before diffing — otherwise the first write to such a file always fails.
norm() {
  cat "$1"
  [ -n "$(tail -c1 "$1")" ] && printf '\n'
  return 0
}

case "$mode" in
  snapshot)
    mkdir -p "$(dirname "$snap")"
    cp "$file" "$snap"
    printf 'snapshot: %s lines\n' "$(wc -l < "$snap" | tr -d ' ')"
    ;;
  verify)
    if [ ! -f "$snap" ]; then
      printf 'FAIL: no snapshot for %s — run `guard.sh snapshot` before editing\n' "$file" >&2
      exit 2
    fi
    lost=$(diff <(norm "$snap") <(norm "$file") | grep '^<')
    if [ -n "$lost" ]; then
      printf 'FAIL: %s pre-existing line(s) removed or modified:\n%s\n' \
        "$(printf '%s\n' "$lost" | wc -l | tr -d ' ')" "$lost" >&2
      printf '\nrestore with: cp %s %s\n' "$snap" "$file" >&2
      exit 1
    fi
    printf 'OK: append-only (+%s lines, -0)\n' \
      "$(diff <(norm "$snap") <(norm "$file") | grep -c '^>')"
    ;;
  *) usage ;;
esac