#!/usr/bin/env bash
# Task 41 Part E: caps a command's resident memory in CI so a future huge
# vendored asset (accidentally included in a fmt/lint pass) can't OOM the
# whole runner the way `ulimit -v` would try to but can't reliably do for a
# V8-based binary like `deno` -- V8 reserves a large virtual address space
# up front regardless of actual usage, so `ulimit -v` kills `deno` on
# startup long before any real memory pressure. This polls the actual
# resident set size (VmRSS) instead and kills the process tree if it's
# exceeded, which is what an OOM would actually be measuring.
#
# Usage: run-with-memory-limit.sh <max_mb> -- <command> [args...]
set -euo pipefail

max_mb="$1"
shift
if [[ "$1" != "--" ]]; then
  echo "usage: run-with-memory-limit.sh <max_mb> -- <command> [args...]" >&2
  exit 2
fi
shift

max_kb=$((max_mb * 1024))

"$@" &
pid=$!

while kill -0 "$pid" 2>/dev/null; do
  rss_kb=$(awk '/VmRSS/ { print $2 }' "/proc/$pid/status" 2>/dev/null || echo 0)
  if [[ -n "$rss_kb" && "$rss_kb" -gt "$max_kb" ]]; then
    echo "run-with-memory-limit: killing pid $pid, RSS ${rss_kb}KB exceeded ${max_kb}KB ceiling" >&2
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    exit 137
  fi
  sleep 0.2
done

wait "$pid"
