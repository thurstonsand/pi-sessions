---
name: npm-release
description: Prepare, publish, tag, and push an npm release for this repo. Use when the user wants to release pi-sessions to npm.
---

# npm Release

Use this skill when preparing and publishing a new npm release for `pi-sessions`.

## Release model

- Release from `main`.
- Publishing happens in CI: `.github/workflows/release.yml` runs the check gate and publishes to npm via trusted publishing (OIDC) when a `vX.Y.Z` tag is pushed. There is no manual `npm publish` step.
- Use the `docs/release.md` entry as the annotated git tag notes.
- Push `main`, then push the tag, to trigger the release.

## 1. Inspect unreleased changes

Find the latest tag and summarize the diff. If the working tree has uncommitted changes, stop and ask whether they belong in the release.

Review release-relevant changes, and summarize:

- user-facing features/fixes
- dependency or peer dependency changes
- config/API changes
- documentation updates
- likely semver bump: patch, minor, or major

Ask the user to confirm the target version unless they already specified it.

## 2. Prepare release notes

Update `docs/release.md` with a new top entry, Keep a Changelog style:

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

If the user edits or cleans up the release notes, use their final `docs/release.md` text for the tag notes later.

## 3. Bump package version

Use npm's version writer, but do not let npm create a commit or tag:

```bash
npm version <patch|minor|major|X.Y.Z> --no-git-tag-version
```

For an explicit version such as `0.3.0`, this is also valid:

```bash
npm version 0.3.0 --no-git-tag-version
```

This should update `package.json` and `package-lock.json`.

## 4. Verify

Run the full gate:

```bash
npm run check
```

Do not proceed on failures. Fix them or report the blocker.

## 5. Commit release prep

Stage files that should be part of the release and commit.

If hooks modify staged files, let the commit finish and then re-check status.

## 6. Dry-run pack

Confirm package contents locally before pushing:

```bash
npm pack --dry-run
```

Read the tarball contents. Make sure expected source files are included and obvious junk is absent.

## 7. Push main and the annotated tag

Use the final `docs/release.md` entry for the tag notes.

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main
git push origin "v$VERSION"
```

Pushing the tag triggers `.github/workflows/release.yml`, which runs the check gate and publishes to npm.

## 8. Watch the release workflow

```bash
gh run watch --workflow=release.yml
```

If it fails, fix the issue and push a new tag — npm rejects republishing an existing version, so a failed tag cannot be reused.

## 9. Final verification

Confirm npm and git remote state:

```bash
npm view pi-sessions version dist-tags --json
git ls-remote --tags origin "v$VERSION*"
git status --short
```

Final report should include:

- npm version published
- release commit hash
- git tag pushed
- verification status
