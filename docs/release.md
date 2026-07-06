# Release

How `pi-sessions` is released to npm. This is the human companion to the `npm-release` skill; the changelog itself lives in [`CHANGELOG.md`](../CHANGELOG.md).

## Release model

`pi-sessions` publishes to npm from GitHub Actions when a stable `vX.Y.Z` tag is pushed. `.github/workflows/release.yml` runs CI, sets the package version from the tag, packs the package, and publishes it with the `latest` dist-tag through npm Trusted Publishing (OIDC). There is no manual `npm publish`.

`package.json`'s version is never bumped locally. The tag is the sole source of truth: CI sets the version from the tag (`npm version "${GITHUB_REF_NAME#v}"`) in its own ephemeral checkout, and that bump is never committed back to `main`.

## Release flow

1. Add a new `## [X.Y.Z] - YYYY-MM-DD` entry to the top of `CHANGELOG.md`.
2. Verify locally with `npm run check` and `npm pack --dry-run`.
3. Commit the release prep.
4. Push `main`.
5. Create an annotated `vX.Y.Z` tag using the matching `CHANGELOG.md` entry as the tag body.
6. Push the tag.
7. The `Release` workflow runs CI, sets the package version from the tag, packs, and publishes to npm.

## Release note extraction

Use the helper script to extract the exact changelog entry for the git tag body:

```bash
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/pi-sessions-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/pi-sessions-v${VERSION}-notes.md"
git push origin main
git push origin "v${VERSION}"
```

## Notes

- Stable package tags are immutable — never force-push one. The one exception is a tag whose release workflow never successfully published: fix the issue, commit it, then delete and recreate that tag.
- If the release workflow fails after the tag is pushed, npm rejects republishing an existing version, so a failed tag cannot be reused as-is — fix, recommit, and follow the exception above.
