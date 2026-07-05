#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 vX.Y.Z [docs/release.md]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

version="${1#v}"
release_file="${2:-docs/release.md}"

if [[ ! -f "${release_file}" ]]; then
  echo "release notes file not found: ${release_file}" >&2
  exit 1
fi

awk -v version="${version}" '
  BEGIN {
    heading = "## [" version "]"
  }

  index($0, heading) == 1 {
    capture = 1
    found = 1
    print
    next
  }

  capture && /^## / {
    exit
  }

  capture {
    print
  }

  END {
    if (!found) {
      printf "release notes not found for v%s\n", version > "/dev/stderr"
      exit 1
    }
  }
' "${release_file}"
