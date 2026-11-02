#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release.sh X.Y.Z (through `mise run release X.Y.Z`)

fail() {
  echo "release: $*" >&2
  exit 1
}

version="${1:-}"
[[ "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "the version must be X.Y.Z, not '${version}'"

cd "$(git rev-parse --show-toplevel)"

branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "${branch}" == "main" ]] || fail "releases come from main, not ${branch:-a detached HEAD}"
[[ -z "$(git status --porcelain)" ]] || fail "the working tree has uncommitted changes"
git fetch --quiet origin main
head="$(git rev-parse HEAD)"
[[ "${head}" == "$(git rev-parse origin/main)" ]] || fail "main does not match origin/main"
ci="$(gh run list --workflow ci.yml --commit "${head}" --limit 1 \
  --json status,conclusion --jq '.[0] | "\(.status) \(.conclusion)"')"
[[ "${ci}" == "completed success" ]] || fail "CI on ${head:0:7} is not green: ${ci:-no run}"

current="$(node -p 'require("./package.json").version')"
IFS=. read -r -a next_parts <<<"${version}"
IFS=. read -r -a current_parts <<<"${current}"
newer=false
for i in 0 1 2; do
  if ((next_parts[i] != current_parts[i])); then
    ((next_parts[i] > current_parts[i])) && newer=true
    break
  fi
done
[[ "${newer}" == "true" ]] || fail "${version} is not newer than ${current}"

grep -qx '## \[Unreleased\]' CHANGELOG.md || fail "CHANGELOG.md has no ## [Unreleased] section"
unreleased="$(awk '$0 == "## [Unreleased]" { capture = 1; next } capture && /^## / { exit } capture' CHANGELOG.md)"
[[ -n "${unreleased//[[:space:]]/}" ]] || fail "## [Unreleased] in CHANGELOG.md is empty"

heading="## [${version}] - $(date +%F)"
awk -v heading="${heading}" '{ print } $0 == "## [Unreleased]" { print ""; print heading }' \
  CHANGELOG.md >CHANGELOG.md.next
mv CHANGELOG.md.next CHANGELOG.md
npm version "${version}" --no-git-tag-version >/dev/null

git add CHANGELOG.md package.json package-lock.json
git commit --quiet -m "chore(release): ${version}"

notes="$(mktemp)"
trap 'rm -f "${notes}"' EXIT
scripts/extract-release-notes.sh "v${version}" >"${notes}"
git tag -a "v${version}" --cleanup=verbatim -F "${notes}"

git push --atomic origin main "v${version}"
echo "Released v${version}; the Release workflow publishes it to npm."
