# Release

How `pi-sessions` is released to npm. This is the human companion to the `npm-release` skill; the changelog itself lives in [`CHANGELOG.md`](../CHANGELOG.md).

## Release model

`package.json` on `main` carries the version of the newest release, and `CHANGELOG.md`'s newest `## [X.Y.Z] - YYYY-MM-DD` section matches it. Changes waiting for a release collect under `## [Unreleased]` at the top. `mise run lint:changelog`, part of `mise run check` and CI, fails when a heading is neither of those two forms, when versions do not strictly descend, or when the newest release is not `package.json`'s version.

Pi reads both: for git and npm installs alike, it compares `package.json`'s version with the one it last saw and shows the newer `CHANGELOG.md` sections after an update. `CHANGELOG.md` ships in the npm package for that reason.

`mise run release X.Y.Z` cuts a release, and pushing its `vX.Y.Z` tag starts `.github/workflows/release.yml`. That workflow first checks that the tag, `package.json` and the changelog's newest section name the same version, then runs CI, packs the package and publishes it with the `latest` dist-tag and provenance through npm Trusted Publishing (OIDC). CI never commits. There is no manual `npm publish`.

## Release flow

1. Collect the release notes under `## [Unreleased]` in `CHANGELOG.md`, push them to `main`, and wait for CI to pass.
2. Run `mise run release X.Y.Z`. It refuses unless it runs on `main` with a clean tree that matches `origin/main`, CI on `HEAD` passed, `## [Unreleased]` has entries, and `X.Y.Z` is newer than `package.json`'s version. Then it:
   - moves the Unreleased entries under `## [X.Y.Z] - <today>` and leaves an empty `## [Unreleased]`;
   - writes `X.Y.Z` into `package.json` and `package-lock.json`;
   - commits `chore(release): X.Y.Z`;
   - creates the annotated tag `vX.Y.Z`, whose body is that changelog section from `scripts/extract-release-notes.sh`;
   - pushes `main` and the tag together.
3. The `Release` workflow checks the version, runs CI, packs, and publishes to npm.

## Notes

- Stable package tags are immutable — never force-push one. The one exception is a tag whose release workflow never successfully published: fix the issue, commit it, then delete and recreate that tag.
- If the release workflow fails after the tag is pushed, npm rejects republishing an existing version, so a failed tag cannot be reused as-is — fix, recommit, and follow the exception above.
