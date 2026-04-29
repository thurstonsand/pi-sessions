# Release Notes

## v0.2.1

Patch release for Pi 0.70 replacement-session APIs and hook write reliability.

- Plain `/handoff` now sends the approved prompt through `withSession.sendUserMessage()` after switching into the fresh replacement session.
- Split-pane handoff remains on the existing environment bootstrap path because it crosses into a separate Pi process.
- Raised Pi package peer/dev dependencies to `0.70.2` for replacement-session context support.
- Added bounded retries and a short SQLite busy timeout for hook-maintained index writes.
- Updated settings loading to use the current Pi settings API.

# Release Process

Use this checklist to publish `pi-sessions` to npm.

## Patch release

1. Confirm the working tree contains only intended changes.

   ```bash
   git status --short
   ```

2. Run the full quality gate.

   ```bash
   npm run check
   ```

3. Bump the package version without letting npm create its own commit or tag.

   ```bash
   npm version patch --no-git-tag-version
   ```

   Use `minor` or `major` instead of `patch` when appropriate.

4. Commit the release.

   ```bash
   git add package.json package-lock.json <changed-files>
   git commit
   ```

5. Confirm npm authentication and package contents.

   ```bash
   npm whoami
   npm publish --dry-run
   ```

6. Publish to npm.

   ```bash
   npm publish
   ```

7. Create and push the matching git tag.

   ```bash
   VERSION=$(node -p "require('./package.json').version")
   git tag -a "v$VERSION" -m "v$VERSION"
   git push origin main
   git push origin "v$VERSION"
   ```

8. Confirm the registry version.

   ```bash
   npm view pi-sessions version
   ```

## Notes

- `npm version patch --no-git-tag-version` updates `package.json` and `package-lock.json` only. It avoids npm's default auto-commit and auto-tag behavior so code changes and the version bump can be committed together.
- If `npm whoami` returns `E401`, run `npm login` before publishing.
- If the publish succeeds but git push fails, do not republish. Fix the git push/tag state only.
