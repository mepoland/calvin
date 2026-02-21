#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
index_file="$repo_root/index.html"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must run inside a git repository." >&2
  exit 1
fi

sha="$(git -C "$repo_root" log -1 --format=%h)"
commit_iso="$(git -C "$repo_root" log -1 --format=%cI)"

if date --version >/dev/null 2>&1; then
  denver_time="$(TZ=America/Denver date -d "$commit_iso" "+%b %-d, %Y %-I:%M %p %Z")"
else
  if ! command -v gdate >/dev/null 2>&1; then
    echo "GNU date (or gdate) is required to format commit time." >&2
    exit 1
  fi
  denver_time="$(TZ=America/Denver gdate -d "$commit_iso" "+%b %-d, %Y %-I:%M %p %Z")"
fi

SHA="$sha" DENVER_TIME="$denver_time" perl -i -pe '
  s{href="styles\.css(?:\?v=[^"]+)?"}{href="styles.css?v=$ENV{SHA}"}g;
  s{<p class="updated-stamp">Updated [^<]*</p>}{<p class="updated-stamp">Updated $ENV{DENVER_TIME} ($ENV{SHA})</p>}g;
' "$index_file"

echo "Updated build stamp: $denver_time ($sha)"
