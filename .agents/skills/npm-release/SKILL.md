---
name: npm-release
description: Prepare, tag, publish, and verify an npm release for this repo. Use when the user wants to release pi-sessions to npm.
---

# npm Release

Use this skill when preparing and publishing a new release for `pi-sessions`.

## Release model

- Release from `main`.
- npm publishing is tag-driven through `.github/workflows/release.yml`.
- Record the changelog in `CHANGELOG.md`: pending entries under `## [Unreleased]`, releases as `## [X.Y.Z] - YYYY-MM-DD`, newest first.
- `package.json` on `main` carries the newest released version. `mise run release X.Y.Z` moves the Unreleased entries into a dated section, sets the version, commits, tags and pushes; nothing else bumps the version, and CI never commits.
- The annotated tag body is the release's `CHANGELOG.md` section, which `mise run release` extracts.
- Stable releases are `vX.Y.Z` tags.
- Stable package tags are immutable. Never force-push a stable release tag.
- The GitHub Action checks that the tag, `package.json` and the changelog's newest section agree, then publishes with provenance through npm Trusted Publishing (OIDC).

## 1. Inspect release state

- Check the current git state before touching anything. If the working tree has unrelated changes, leave them alone. If release-relevant changes are uncommitted, ask whether they belong in the release before proceeding.
- Inspect changes since the latest stable tag.
- Summarize:
  - user-facing features and fixes
  - package, install, or release changes
  - API changes
  - documentation updates
  - likely bump: patch, minor, or major, by the versioning rule in `docs/release.md`

Ask the user to confirm the target version unless they already specified it.

## 2. Prepare release notes

Review and complete the entries under `## [Unreleased]` at the top of `CHANGELOG.md`, Keep a Changelog style. `mise run release` turns that heading into `## [X.Y.Z] - YYYY-MM-DD`:

```md
## [Unreleased]

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

If the user edits or cleans up the release notes, keep their final `CHANGELOG.md` text; the tag body comes from it.

If release mechanics change, update this skill and `docs/release.md`.

## 3. Verify locally

Run the full gate and inspect package contents:

```sh
mise run check
npm pack --dry-run
```

Read the tarball contents. Make sure expected source files, `CHANGELOG.md` and `dist/session-messaging/broker/process.js` are included and obvious junk is absent. The version shown here is the last release's; `mise run release` sets the new one.

Do not proceed on failures. Fix them or report the blocker.

## 4. Commit and push the release notes

Stage only release-relevant files (release notes, code changes) and commit; leave `package.json`'s version alone. Push to `main` and wait for CI on that commit to pass: `mise run release` refuses to run until it has.

The pre-commit hook rejects the commit on issues. Raise any issues to the user to decide how to proceed.

## 5. Run the release task

Publishing is immutable: get the user's approval of the version first.

```sh
mise run release X.Y.Z
```

It refuses unless it runs on `main` with a clean tree that matches `origin/main`, CI on `HEAD` passed, `## [Unreleased]` has entries, and the version is newer than `package.json`'s. Then it dates the Unreleased section, writes the version into `package.json` and `package-lock.json`, commits `chore(release): X.Y.Z`, creates the annotated `vX.Y.Z` tag with that section as its body, and pushes `main` and the tag together. Report any refusal to the user rather than working around it.

Do not force-push a stable tag. If a tag already exists, stop and inspect; do not overwrite it. The one exception is a tag whose release workflow never successfully published — that tag is safe to delete and recreate once the underlying issue is fixed and committed.

## 6. Watch GitHub Actions publishing

The tag should trigger the Release workflow.

- Use the `gh` tool to find the release (`gh run list --workflow=release.yml`).
- Watch the release action to completion.
- The workflow should check that the tag, `package.json` and the changelog agree, run CI, and publish to npm with the `latest` dist-tag.
- If there is an error, inform the user what went wrong, including a proposed fix when feasible.

## 7. Final verification

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
