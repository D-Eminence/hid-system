#!/usr/bin/env bash
set -euo pipefail

baseline_repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$baseline_repository"

baseline_branch="$(git branch --show-current)"
baseline_commits="$(git rev-list --count HEAD)"
baseline_tracked="$(git ls-tree -r --name-only HEAD)"

if [[ "$baseline_branch" != "main" ]]; then
  echo 'pre-baseline verification requires main' >&2
  exit 1
fi
if [[ "$baseline_commits" != 1 ]]; then
  echo 'pre-baseline verification requires exactly one existing commit' >&2
  exit 1
fi
if [[ "$baseline_tracked" != 'README.md' ]]; then
  echo 'pre-baseline HEAD must contain only README.md' >&2
  exit 1
fi
if ! git diff --cached --quiet; then
  echo 'pre-baseline verification requires an empty Git index' >&2
  exit 1
fi

for baseline_path in .gitignore .dockerignore CODEX.md package.json apps services packages gateway infra docs scripts; do
  if [[ ! -e "$baseline_path" ]]; then
    echo "canonical baseline path is missing: $baseline_path" >&2
    exit 1
  fi
done
for baseline_ignored in identity/hid-unified1.zip upstream_snapshot/package.json .env.local; do
  if ! git check-ignore -q -- "$baseline_ignored"; then
    echo "pre-baseline exclusion is missing: $baseline_ignored" >&2
    exit 1
  fi
done

printf '%s\n' '{"status":"passed","branch":"main","commitsAtHead":1,"trackedFilesAtHead":["README.md"],"stagedFiles":0,"canonicalSourceSafeToStage":true,"ignoredReferenceDirectories":["identity/","upstream_snapshot/"]}'
