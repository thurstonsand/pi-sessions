---
name: renovate-batch-merge
description: Use when Renovate has opened its scheduled batch of dependency PRs and the maintainer wants them cleared in one pass instead of reviewed one by one. Lands the whole batch on main as a single commit and lets Renovate close its own PRs.
---

# Renovate Batch Merge

Renovate opens its scheduled updates as a batch of grouped PRs. This skill **lands** the whole batch — majors included — on `main` as one commit; Renovate then **reconciles**, recognizing the updates on `main` and closing the PRs itself.

## Model

- **Land, don't merge.** Read each PR's diff and author the equivalent edit directly on `main`, rather than merging branches or applying patches. The updates are small — version bumps in manifests and lockfiles — so reproduce them by hand and understand what you land.
- **The whole batch, one commit.** Every open Renovate update, plus any formatter fallout it triggers, goes in a single commit. No triage, no held-back majors.
- **Renovate reconciles.** Once the batch is on `main`, Renovate closes the PRs it sees landed. Close a PR by hand only when Renovate leaves it open after its update is already on `main`.

## Workflow

### 1. Inspect

Read the dashboard and list the open batch:

```bash
gh issue list --search "Dependency Dashboard in:title" --state open
gh pr list --author app/renovate --state open \
  --json number,title,url,updatedAt,labels --limit 50
```

Done when you hold the full list of open Renovate PRs.

### 2. Land the batch

Start from a current `main` and for each open Renovate PR, read its diff and make the same edit yourself directly on `main`. Apply every update's manifest and regenerate lockfiles as needed. When a formatter or linter bump in the batch turns the local gate red, run the formatter and fold its mechanical output into the same commit, so the bump and its fallout land together. Commit all changes across all PRs at once.

Done when every open update is authored into one commit on `main` and pushed.

### 3. Verify

Done when the batch commit's `main` CI is green. Fix a red run before reconciling.

### 4. Reconcile

Give Renovate a few minutes to close the landed PRs. For any it leaves open once its update is on `main`, close it manually with a comment along the lines of `Closing as superseded by <commit>, which already applies this update on main.`

Done when no PR whose update is on `main` remains open.

### 5. Report

Report the batch commit SHA and its updates, the `main` CI result and URL, which PRs Renovate closed versus closed by hand, and anything left open with why.
