# Release Notes

## v0.5.1

Pi dependency compatibility update.

- Bumped Pi dependencies to `0.80.2`.

## v0.5.0

Background session handoffs from agents.

- Added the `session_handoff` tool for Ghostty/macOS background handoffs.
- Tool-launched child sessions now collect context and show the handoff review countdown in the new split while the current session continues.
- Added `/handoff --identify` to refresh the Ghostty source pane used for background handoffs.
- Added optional target working directories for handoffs into related repos.

## v0.4.1

Richer handoff draft extraction.

- `/handoff` now uses a read-only Pi extraction agent so generated handoff prompts can include relevant file context from the workspace.

## v0.4.0

Session index reliability and incremental hook indexing.

- Fixed hook-maintained index writes under concurrent Pi processes by queueing writes with immediate SQLite transactions and connection-level busy timeouts.
- Added incremental hook sync so unchanged sessions are skipped and appended session JSONL is indexed without rewriting existing rows.
- Reduced lineage refresh work to the affected session family during hook updates.
- Switched text search to external-content FTS5 triggers so indexed text stays in lockstep with stored chunks.
- Bumped the session index schema to version 8; rebuild the index with `/session-index` if needed.

## v0.3.2

Patch release for Bun-compatible session indexing and handoff reasoning settings.

- Added Bun runtime support for the session index SQLite backend while preserving Node support through `better-sqlite3`.
- Made rebuilt index files self-contained by checkpointing WAL data before replacing the live index.
- Handoff draft generation now reuses the active session thinking level when the selected model supports reasoning.
- Made package installation more tolerant when Husky is unavailable.

## v0.3.1

Patch release for Pi 0.78.1 mode handling.

- Guarded TUI-only command panels with Pi's explicit extension mode so RPC, JSON, and print modes do not enter custom TUI flows.
- Raised Pi peer/dev dependencies to `0.78.1`.
- Added a repo-local npm release skill for future release workflow guidance.

## v0.3.0

Configurable auto-title generation prompt and improved handoff session titles.

- Added `sessions.autoTitle.prompt` so users can customize generated title style.
- Capped generated auto-titles at 80 characters.
- Plain `/handoff` now waits for the old transcript to clear before the approved prompt starts.
- Raised Pi peer/dev dependencies to `0.78.1`.

## v0.2.2

Patch release for the Pi package scope migration.

- Migrated Pi peer/dev dependencies and imports from `@mariozechner/*` to `@earendil-works/*`.
- Migrated TypeBox imports from `@sinclair/typebox` to `typebox` for Pi 0.69+ compatibility.
- Added a Node engine range matching current `better-sqlite3` support and pinned local development to Node 24.
- Refreshed direct development dependencies and lockfile metadata.

## v0.2.1

Patch release for Pi 0.70 replacement-session APIs and hook write reliability.

- Plain `/handoff` now sends the approved prompt through `withSession.sendUserMessage()` after switching into the fresh replacement session.
- Split-pane handoff remains on the existing environment bootstrap path because it crosses into a separate Pi process.
- Raised Pi package peer/dev dependencies to `0.70.2` for replacement-session context support.
- Added bounded retries and a short SQLite busy timeout for hook-maintained index writes.
- Updated settings loading to use the current Pi settings API.

## Release Process

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
