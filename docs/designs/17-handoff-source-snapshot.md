# Handoff Source Snapshot and Extraction Clarity

## Status

Superseded by design 18, Phase 9

## Decision Summary

Background handoff extraction reads a stable **handoff source snapshot** rather than reopening the source session at its latest leaf. The snapshot is the source conversation branch anchored immediately before the assistant turn that invokes `session_handoff`, excluding the handoff call, its result, later parent activity, and other branches.

The extraction model keeps broad editorial control over `nextTask`. This design does not make the tool-supplied goal immutable child wording, duplicate it into the assembled prompt, impose a new context-size budget, or remove assistant thinking. Instead, it isolates the extractor's role from Pi's generic coding prompt while retaining project context, and makes the source/goal/actor boundaries clearer with a small prompt amendment.

## Problem Statement / Background

Tool-launched handoffs generate and review their draft in the child session. The bootstrap currently gives the child the parent session file and a goal. When the child starts, it reopens that file and builds context from the parent's latest leaf.

That file is still growing. By extraction time it may contain:

- the assistant message that invoked `session_handoff`
- the successful tool result identifying the child
- later parent-agent coordination
- statements that the child was launched or that the parent is waiting on it

A concrete failure occurred in session `466b3436-2167-4853-b168-ac7c775bc307`. Its tool-supplied goal was to update Glimpse Companion lifecycle behavior, but its generated task instructed the child to wait for Thurston and later launch one of two unrelated handoffs. Its context also described the Glimpse handoff as already launched and named that same child session id. The destination had observed evidence of its own creation in the live parent transcript.

Pi's session tree already provides the required snapshot mechanism. `buildSessionContext(entries, leafId)` walks from one entry to the root, includes only that conversation branch, and applies compaction and branch-summary semantics along the path. New descendants and sibling branches do not affect the result. Persisting the invocation-time source entry id therefore creates a logical snapshot without copying transcript data.

The existing extractor prompt also leaves actor and timeline relationships implicit. It says that the model extracts context for a handoff, but labels the evidence only as `Conversation` and the request only as `Goal`. Because serialized history can include old handoff prompts and coordination statements, a small amount of additional framing may help the extractor interpret those statements as source history rather than destination state.

## Goals

- Prevent child-side handoff extraction from observing its own launch or later parent activity.
- Preserve the exact source conversation branch that caused the handoff, including existing compaction semantics.
- Keep the extraction model's intended authority to synthesize a more complete `nextTask` from the supplied goal and source context.
- Clarify source, extractor, and destination roles without accumulating a large defensive prompt.
- Keep project-specific context available to the extractor while removing Pi's unrelated generic coding-agent role.
- Make the failure reproducible through deterministic branch-boundary tests and a focused live extraction scenario.

## Non-Goals

- Making the tool-supplied goal the verbatim or immutable child task.
- Rendering both the original goal and synthesized `nextTask` in the child prompt.
- Adding lexical-overlap checks, a second model verifier, or another semantic drift validator.
- Adding a handoff-specific total token or character budget.
- Removing assistant thinking, tool calls, or tool results from the source snapshot.
- Replacing direct transcript delivery with `session_ask`-style transcript navigation tools.
- Changing the extraction schema or deterministic handoff draft layout.

## Exposed Shape

### Source session → handoff orchestration

When `session_handoff` executes, orchestration captures the source branch boundary before creating the child.

The running Pi version persists the assistant message containing the tool call before tool execution begins. The current source leaf is therefore that assistant message. The snapshot anchor is its `parentId`: the source branch immediately before the invoking assistant turn.

The boundary data is:

```ts
{
  parentSessionFile: string;
  sourceLeafId: string;
  goal: string;
}
```

`sourceLeafId` is an entry id, not a copy of the branch. The source session file remains the durable source of truth.

No additional validation is needed when choosing the anchor. The implementation relies on Pi's tool-execution ordering and takes the current leaf's `parentId`.

### Handoff bootstrap → child extraction

The child-generated bootstrap persists `sourceLeafId` alongside the existing parent session reference and goal. This field works in today's environment bootstrap and later moves unchanged into Design 16's pending-bootstrap entry. Design 16 is not a prerequisite for this change.

On child startup:

1. open the parent session file
2. require the anchored source entry to exist
3. build source context with `buildSessionContext(entries, sourceLeafId)`
4. serialize that context and run extraction

Later entries may exist in the parent file, but they are not ancestors of `sourceLeafId` and cannot enter the extracted source context. Other conversation branches are excluded for the same reason.

If the parent file or source entry is unavailable, extraction must not silently fall back to the parent's latest leaf. A latest-leaf fallback recreates the original bug.

### Source snapshot → extraction agent

The extraction agent continues to receive the complete compaction-aware source branch directly in its prompt. It does not navigate the transcript through tools.

Its available tools remain:

- `read`
- `grep`
- `find`
- `ls`
- `create_handoff_context`

The first four inspect the target workspace. `create_handoff_context` returns the structured extraction and terminates the nested run.

There is no new total source-size cap. Pi's normal session context construction already applies existing compactions and branch summaries. `serializeConversation()` truncates each tool result to 2,000 characters; user text, assistant text, and assistant thinking retain their current behavior. Oversized uncompacted source sessions are a separate problem requiring evidence and a deliberate lossy-context policy.

### Resource loader → extraction system prompt

The nested agent should use the handoff extraction prompt as its custom system prompt instead of appending it to Pi's generic coding-agent prompt. Project/global context files remain enabled and are appended by Pi to that custom prompt.

Conceptually:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  noPromptTemplates: true,
  noSkills: true,
  systemPrompt: HANDOFF_SYSTEM_PROMPT,
});
```

This isolates the agent's role while retaining project-specific instructions. The read-only workspace tools remain available regardless of whether project context files are injected.

### Extraction output → handoff draft

The existing structured contract remains:

```ts
create_handoff_context({
  title: string,
  summary: string,
  relevantFiles: string[],
  nextTask: string,
  openQuestions?: string[],
})
```

`nextTask` remains the model's synthesized destination task and remains the sole content under `## Task`. The original goal remains durable handoff metadata but is not duplicated into the child prompt.

This deliberately permits broad editorial synthesis. The goal is guidance to the extraction agent about why the destination is being created, not immutable destination wording.

Design 16 later makes the title supplied by `session_handoff` authoritative and removes title generation from this child extraction path. This design can land first with the current title field; Design 16 then performs that already-planned schema change.

## Prompt Contract

This section records the current prompt, its duplication audit, and the accepted consolidated wording.

### Current system prompt

```text
You extract context for a deliberate session handoff.

You must call create_handoff_context exactly once.

Rules:
- Extract only context that is relevant to the next task.
- Keep the summary compact and concrete.
- Prefer workspace-relative file paths when possible.
- title must be a short session title for the new handoff thread, 64 characters or less, without prefixes like "Handoff:" or otherwise referencing the current thread.
- nextTask must be the concrete next action for the new session.
- openQuestions should contain only unresolved items that materially affect the next task.
- If there are no meaningful open questions, omit openQuestions entirely.
- Do not write the final handoff prompt yourself.
```

The user prompt currently uses:

```text
## Conversation
<serialized conversation>

## Goal
<tool-supplied goal>

Call create_handoff_context exactly once.
```

### Current tool and argument descriptions

```text
create_handoff_context
  Extract the structured handoff context for the next session.

  title
    Short display title for the new handoff session.

  summary
    Only the context relevant to the next task.

  relevantFiles
    Relevant workspace-relative file paths when possible.

  nextTask
    The concrete next task for the new session.

  openQuestions
    Open questions that matter to the next task. Omit when there are none.
```

The tool description does not say that the tool must be called exactly once. That instruction currently appears twice: once in the system prompt and once at the end of the user prompt. The first successful call also returns `terminate: true`, so a second call cannot occur in the same extraction run. Only one positive instruction to call the tool is needed.

### Duplication audit

| System-prompt rule                                                       | Existing tool/schema coverage                                                      | Assessment                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Call `create_handoff_context` exactly once                               | Not in the description; repeated in the user prompt; first call terminates the run | Keep one call instruction, not two; `exactly once` adds nothing beyond termination                                 |
| Extract only context relevant to the next task                           | `summary` says this, while other fields have their own relevance descriptions      | Partial overlap; useful only if intended as a whole-output rule                                                    |
| Keep the summary compact and concrete                                    | `summary` covers relevance but not compactness or concreteness                     | Unique                                                                                                             |
| Prefer workspace-relative file paths                                     | Repeated exactly by `relevantFiles`                                                | Duplicate                                                                                                          |
| Short title, at most 64 characters, no `Handoff:`/current-thread framing | `title` says only “Short”; runtime enforces 64 characters                          | Partial overlap; prefix/thread guidance exists only here. Design 16 later removes this field from child extraction |
| `nextTask` is the concrete destination action                            | Repeated by `nextTask`                                                             | Duplicate                                                                                                          |
| Open questions must matter to the task                                   | Repeated by `openQuestions`                                                        | Duplicate                                                                                                          |
| Omit open questions when empty                                           | Repeated by `openQuestions` and represented by an optional schema field            | Duplicate                                                                                                          |
| Do not write the final prompt                                            | Implied by returning structured fields, but not stated in the tool description     | Potentially useful role boundary                                                                                   |

Most rules are sediment from before the schema descriptions became specific. The argument-specific meanings should live with their arguments. The system prompt should retain only cross-field role and process guidance.

### Accepted consolidated wording

The opening prose below incorporates the reviewed source/goal framing. The previously proposed lifecycle rule is intentionally omitted; the opening prose carries that distinction without another prohibition.

```text
You extract context for a deliberate session handoff. You are preparing a briefing for a new destination session from a historical source snapshot.

The Handoff Goal states why the destination session is being created. Use the source snapshot to make that goal concrete and actionable.
```

Accepted tool and argument descriptions:

```text
create_handoff_context
  Submit the completed structured briefing for the destination session. You must call this tool to complete extraction. Calling it ends the extraction run, so finish any workspace exploration first.

  title
    Short display title for the destination session, 64 characters or less. Do not prefix it with “Handoff:” or describe the source thread.

  summary
    Compact, concrete source context relevant to the destination task.

  relevantFiles
    Relevant workspace-relative file paths when possible.

  nextTask
    Concrete, actionable destination task synthesized from the Handoff Goal and Source Snapshot.

  openQuestions
    Unresolved questions that materially affect the destination task. Omit when there are none.
```

The accepted user-prompt headings are:

```text
## Source Snapshot
<serialized anchored branch>

## Handoff Goal
<tool-supplied goal>
```

There is no separate system- or user-prompt instruction to call the tool. The top-level tool description is the single source of truth for both mandatory use and termination.

Design 16 later removes the `title` argument and its description from child-generated extraction because the public `session_handoff` call supplies the authoritative title.

### `promptSnippet` and `promptGuidelines`

Do not add `promptSnippet` or `promptGuidelines` to `create_handoff_context` under this design.

Pi uses those fields only while constructing its default system prompt. When the resource loader supplies the custom handoff system prompt, Pi appends project context and returns that custom prompt without constructing the default `Available tools` or `Guidelines` sections. The nested model still receives the tool's provider-facing name, description, and argument schema.

Defining snippet or guideline fields would therefore create dead metadata. The tool and argument descriptions own interface and termination semantics; the custom system prompt owns the extractor's role.

The implementation should leave a short comment beside the `defineTool()` call because this omission is otherwise surprising:

```ts
// Pi does not inject promptSnippet or promptGuidelines when a custom system prompt is active.
```

## Design Decisions

### 1. Anchor before the invoking assistant turn

The handoff source snapshot ends at the parent of the assistant message containing `session_handoff`.

The goal already carries the current assistant's delegation intent. Including the tool-call message would duplicate that goal and produce an unmatched tool call because its result does not exist at the chosen boundary. Anchoring afterward permits self-observation. Anchoring before the turn is the clean structural boundary.

### 2. Use a logical branch snapshot, not copied transcript data

A source leaf id is sufficient because Pi session entries form an append-only parent-linked tree and `buildSessionContext` accepts an explicit leaf. This preserves compaction semantics and excludes later/sibling entries without inflating bootstrap storage.

The tradeoff is continued dependency on the parent session file. That dependency already exists, and a handoff explicitly records its source session.

### 3. Keep direct transcript delivery

The extractor receives the anchored source context directly. A navigation-agent architecture would add retrieval queries, missed-span risk, multiple model turns, and session-ask-like machinery without addressing the observed temporal bug better than a leaf anchor.

### 4. Preserve broad `nextTask` synthesis

The model may produce a more complete destination task than the supplied goal. The design intentionally does not force verbatim carry-through or deterministic semantic equivalence.

This means prompt and review quality remain part of the product. The snapshot boundary removes the concrete source of the self-referential failure; it does not make every editorial choice mechanically verifiable.

### 5. Isolate the extractor role while retaining project context

The handoff prompt becomes the nested agent's custom system prompt. Project context files remain attached because they may contain conventions relevant to file selection and task shaping.

This removes Pi's generic coding-agent identity without discarding project-specific constraints. It is a narrower intervention than `noContextFiles: true`.

### 6. Add no new source-size policy

There is no observed handoff overflow incident, and every deterministic trimming strategy can remove old context that motivated handoff in the first place. The anchored branch continues to use Pi's own compaction-aware context.

If oversized source prompts become a demonstrated failure, they need a separate design choosing between deterministic trimming, intermediate summarization, or transcript navigation.

### 7. Preserve assistant thinking

The handoff source remains equivalent to Pi's current serialized compaction input, including assistant thinking. This maximizes available evidence and avoids broadening the current fix into an evidence-content policy change.

## Edge Cases & Failure Modes

- **Parent appends the handoff result before child extraction:** ignored because it is not an ancestor of `sourceLeafId`.
- **Parent continues for several turns:** ignored for the same reason.
- **Parent rewinds and creates another branch:** excluded unless it is on the root-to-`sourceLeafId` path.
- **Source branch already contains a compaction:** `buildSessionContext` applies that compaction at the anchored leaf.
- **Parent compacts after the handoff invocation:** the later compaction is not part of the snapshot.
- **Several tool calls occur in one assistant message:** anchoring at that assistant message's parent excludes the whole invoking assistant turn and all of its tool calls.
- **Source entry is missing:** child extraction checks `sourceSessionManager.getEntry(sourceLeafId)` and fails visibly. This guard is necessary because Pi otherwise treats an unknown leaf id as absent and silently builds context from the latest entry.
- **Source file grows while being read:** later complete entries may be loaded but cannot enter the anchored path.
- **Source session is very large and uncompacted:** current behavior remains; model context overflow is possible and is not silently repaired by arbitrary trimming.
- **Project instructions conflict with extractor behavior:** the custom handoff system prompt defines the role, but project context remains present. Prompt precedence and focused smoke testing must verify this compromise.
- **Extractor chooses a materially different task from the goal:** human review remains the correction surface; this design adds framing but no semantic rejection mechanism.

## Verification

### Deterministic snapshot-boundary test

Add one focused test around the source snapshot boundary. Build a session tree containing:

1. source history ending at the intended anchor
2. the assistant message invoking `session_handoff`
3. the resulting child-id tool result
4. later parent-agent coordination
5. an unrelated sibling branch

Capture the source anchor before the invoking assistant turn and inspect the conversation passed to the extraction agent. The anchored source history must be present; the invoking tool call, result, later coordination, and sibling branch must be absent.

Also cover the missing-anchor guard because Pi's `buildSessionContext` otherwise falls back to the latest entry. Do not add tests whose only purpose is asserting every accepted prose sentence. Update existing prompt/tool tests where their current expectations change.

### Original-incident replay

Replay the actual failed Glimpse handoff through the implemented extractor.

Source session:

- session: `019f48ba-2e7f-7b9b-9d91-0b38ae342e76`
- file: `/Users/thurstonsand/.pi/agent/sessions/--Users-thurstonsand-Develop-ansiblonomicon--/2026-07-09T21-13-08-991Z_019f48ba-2e7f-7b9b-9d91-0b38ae342e76.jsonl`
- invoking `session_handoff` entry: `40a523b7`
- source snapshot anchor: `295b6550`
- contaminating tool result: `f6899c72`
- contaminating later assistant receipt: `7e49ad18`
- original child: `466b3436-2167-4853-b168-ac7c775bc307`

Use the exact original goal stored in the source tool call. It asks the destination to update Glimpse Companion from `agent_end` to `agent_settled`, preserve manual-idle `session_compact` behavior, update focused tests/dependencies, validate the work, and preserve unrelated staged/unstaged changes.

Review the real generated draft rather than turning stochastic wording into a permanent test assertion. Acceptance evidence:

- `nextTask` directs the destination toward the Glimpse Companion lifecycle work
- it does not redirect the destination to wait for Thurston or launch the pending Pi Sessions/Claude Bridge handoffs
- context does not say that child `466b3436-2167-4853-b168-ac7c775bc307` has already been launched
- no content from entries `40a523b7`, `f6899c72`, or `7e49ad18` appears as source evidence

The replay is smoke evidence, not a deterministic quality gate. The snapshot-boundary test proves the structural guarantee.

## Alternatives

### Anchor at the assistant tool-call message

- **Status:** Rejected
- **Decision:** It includes a duplicated handoff call without its eventual result and is one entry later than the clean source boundary.
- **Discussion:** It would still avoid the self-launch receipt, but gives the extractor a dangling tool call that adds no information beyond the separately supplied goal.

### Copy the source branch into bootstrap state

- **Status:** Rejected
- **Decision:** An entry-id anchor provides the same branch isolation without duplicating potentially large transcript data.
- **Discussion:** A physical copy would survive deletion or corruption of the parent file, but handoff lineage already assumes the parent session exists and Design 16 deliberately reduces bootstrap payload size.

### Replace `nextTask` with the exact goal

- **Status:** Rejected
- **Decision:** The extraction agent is intended to turn the goal and conversation into a more complete destination task.
- **Discussion:** Exact goal rendering would eliminate semantic drift but also remove a core purpose of structured handoff extraction.

### Show both goal and next task

- **Status:** Rejected
- **Decision:** The child prompt should keep one authoritative `## Task`; the exact goal remains in durable metadata.
- **Discussion:** Two task surfaces make drift visible but can also conflict or repeat each other.

### Transcript navigation tools

- **Status:** Rejected
- **Decision:** Keep deterministic direct delivery of the compaction-aware branch.
- **Discussion:** Navigation is valuable for arbitrary historical recall, as in `session_ask`, but unnecessary for one already-selected active branch.

### Exclude project context files

- **Status:** Rejected
- **Decision:** Isolate the system role while retaining project instructions.
- **Discussion:** Full isolation removes potential contamination but also removes conventions that can help the extractor identify relevant files and constraints.

### Add explicit semantic drift validation

- **Status:** Rejected
- **Decision:** Broad editorial synthesis and human review remain intentional. Lexical checks are brittle; a second model verifier adds another stochastic and latency boundary.
- **Discussion:** Reconsider only if anchored extraction continues to redirect tasks in practice.

### Put extractor guidance in `promptSnippet` or `promptGuidelines`

- **Status:** Rejected
- **Decision:** Pi does not inject those fields when a custom system prompt is active; keep live guidance in the custom prompt and provider-facing tool descriptions.
- **Discussion:** These fields would become appropriate only if extraction returned to Pi's default system prompt, which would conflict with the chosen role isolation.

## Implementation Plan

- [ ] Phase 1: Anchor child-generated extraction to the invocation-time source branch
  - Goal: Make self-observation structurally impossible without changing handoff extraction content or review behavior.
  - Files: `extensions/session-handoff.ts`, `extensions/session-handoff/metadata.ts`, `extensions/session-handoff/extract.ts`, `test/session-handoff.extension.test.ts`, `test/session-handoff.extract.test.ts`, `test/session-handoff.spawn.test.ts` as required by existing test boundaries.
  - Work: Add `sourceLeafId` to the child-generated bootstrap; capture the invoking assistant entry's parent before preparing the child; pass that anchor into child-side generation; require the anchor to exist before calling Pi's `buildSessionContext`; build and serialize context from that explicit leaf. Keep the current environment bootstrap so Design 16 can later move the same field into its pending entry. Leave title extraction unchanged.
  - Validation: Add one tree-shaped regression test proving the extraction prompt includes the anchored branch but excludes the invoking tool call, child-id result, later parent activity, and a sibling branch; cover rejection of a missing anchor so Pi cannot silently fall back to the latest leaf; update metadata/spawn expectations; run focused handoff tests.

- [ ] Phase 2: Consolidate the extractor prompt and isolate its role
  - Goal: Give the extraction agent the accepted source/goal framing and one provider-facing structured-output contract without duplicate prompt rules.
  - Files: `extensions/session-handoff/extract.ts`, `test/session-handoff.extract.test.ts`.
  - Work: Replace the appended prompt with the accepted custom system prompt while retaining project context files; rename user-prompt headings to `Source Snapshot` and `Handoff Goal`; apply the accepted tool and argument descriptions; remove duplicate call/rule prose; omit `promptSnippet` and `promptGuidelines`; add the focused code comment explaining that Pi does not inject those fields with a custom system prompt. Do not remove assistant thinking or add a source-size cap.
  - Validation: Adjust existing tests for changed headings and tool behavior rather than adding sentence-by-sentence prompt assertions; verify the nested resource loader uses the handoff custom prompt instead of Pi's generic coding-agent prompt; run focused extraction tests.

- [ ] Phase 3: Replay the original failure and run the full quality gate
  - Goal: Demonstrate that the structural fix produces a useful briefing for the incident that motivated it.
  - Files: no permanent replay fixture required; use the source session and entry ids recorded in this design.
  - Work: Run the implemented extractor against source session `019f48ba-2e7f-7b9b-9d91-0b38ae342e76`, anchored at `295b6550`, with the exact goal from tool-call entry `40a523b7`; capture the generated draft as review evidence; confirm the contaminating entries `f6899c72` and `7e49ad18` cannot enter source context.
  - Validation: Review that the task remains the Glimpse Companion lifecycle change, does not redirect toward pending handoffs, and does not describe child `466b3436-2167-4853-b168-ac7c775bc307` as already launched; run `npm run check`; report the stochastic smoke result separately from deterministic test evidence.
