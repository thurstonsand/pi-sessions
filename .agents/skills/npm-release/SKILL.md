---
name: npm-release
description: Prepare, tag, publish, and verify an npm release for this repo. Use when the user wants to release pi-sessions to npm.
---

# npm Release

Use this skill when preparing and publishing a new release for `pi-sessions`.

## Release model

- Release from `main`.
- npm publishing is tag-driven through `.github/workflows/release.yml`.
- Record the changelog in `CHANGELOG.md`
- Use the exact same release-note text from `CHANGELOG.md` for the annotated git tag body.
- Stable releases are `vX.Y.Z` tags.
- Stable package tags are immutable. Never force-push a stable release tag.
- The GitHub Action uses npm Trusted Publishing through OIDC.
- `package.json`'s version is never bumped locally. The tag is the sole source of truth: CI sets the version from the tag in its own ephemeral checkout, and that bump is never committed back to `main`.

## 1. Inspect release state

- Check the current git state before touching anything. If the working tree has unrelated changes, leave them alone. If release-relevant changes are uncommitted, ask whether they belong in the release before proceeding.
- Inspect changes since the latest stable tag.
- Summarize:
  - user-facing features and fixes
  - package, install, or release changes
  - API changes
  - documentation updates
  - likely semver bump: patch, minor, or major

Ask the user to confirm the target version unless they already specified it.

## 2. Prepare release notes

Update `CHANGELOG.md` with a new top entry, Keep a Changelog style:

```md
## [X.Y.Z] - YYYY-MM-DD

- **Short feature title** - One-sentence description of the headline capability.

### Added

- User-facing addition.

### Changed

- User-facing behavior change, including breaking changes (spell out the impact and migration in the bullet itself).

### Fixed

- User-facing bug fix.

### Removed

- User-facing removal.
```

Only include the headline bullets for releases with a genuine headline capability worth calling out up top; skip them for patch releases, dependency bumps, or single-bullet changes. Only include the other sections that apply; omit empty ones. Keep notes concise. Do not dump every internal refactor. Prefer what a user needs to know.

If the user edits or cleans up the release notes, use their final `CHANGELOG.md` text for the tag notes later.

If release mechanics change, update this skill and `docs/release.md`.

## 3. Verify locally

Run the full gate and inspect package contents:

```sh
npm run check
npm pack --dry-run
```

Read the tarball contents. Make sure expected source files are included and obvious junk is absent. The version shown here is `package.json`'s current (stale) version, not the version being released — that's expected; CI sets the real version from the tag.

Do not proceed on failures. Fix them or report the blocker.

## 4. Commit release prep

Stage only release-relevant files (release notes, code changes — not a `package.json` version bump) and commit.

If hooks modify staged files, the commit will fail. Ensure the hook is resolved, then recommit.

## 5. Push main

Push the release prep commit to `main`.

## 6. Create and push the stable tag

Use the final `CHANGELOG.md` entry for the tag notes:

```sh
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/pi-sessions-v${VERSION}-notes.md"
cat "/tmp/pi-sessions-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/pi-sessions-v${VERSION}-notes.md"
git push origin "v${VERSION}"
```

Do not force-push a stable tag. If a tag already exists, stop and inspect; do not overwrite it. The one exception is a tag whose release workflow never successfully published — that tag is safe to delete and recreate once the underlying issue is fixed and committed.

## 7. Watch GitHub Actions publishing

The tag should trigger the Release workflow.

- Use the `gh` tool to find the release (`gh run list --workflow=release.yml`).
- Watch the release action to completion.
- The workflow should run CI, set the package version from the tag, and publish to npm with the `latest` dist-tag.
- If there is an error, inform the user what went wrong, including a proposed fix when feasible.

## 8. Final verification

Confirm npm and git remote state:

```sh
VERSION=X.Y.Z
npm view pi-sessions version dist-tags --json
git ls-remote --tags origin "v${VERSION}"
git status --short
```

Final report should include:

- npm version published
- release commit hash and tag
- workflow watched and whether it passed
- verification status
- any follow-up work or issues encountered
