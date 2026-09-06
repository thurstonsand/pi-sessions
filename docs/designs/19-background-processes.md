# Background Processes

## Status

Placeholder — revisit after Design 18 (tmux sub-agents) is complete.

## Concept

Pi Sessions could manage background processes with the same broad lifecycle affordances as sub-agents: launch work outside the user's terminal, make its status discoverable, preserve enough durable state to recover after Pi restarts, and provide a deliberate way to stop or reattach to it.

Unlike a sub-agent, a background process is not a Pi session. It has no transcript, model, broker identity, handoff context, or `report_results` contract. It is a command with process lifecycle and output concerns.

Potential uses include long-running tests, development servers, builds, migrations, downloads, and project-specific watchers.

## Questions to Resolve

- What is the user-facing surface: a dedicated tool, a `/process` board, or an extension API for other features?
- Which launch substrates are supported: detached tmux windows only, or a pluggable process backend like handoff launch backends?
- What durable records are needed to distinguish desired processes from runtime evidence, especially across restarts and rewinds?
- How should output work: tmux observation, captured logs, streaming into the transcript, or a combination?
- What process identity is safe to persist and reconcile without accidentally killing unrelated work?
- What are the ownership, cancellation, cleanup, and shutdown semantics?
- Can a process expose a completion result, and if so, how is that distinct from sub-agent reports?
- How should project-defined commands, environment, cwd, and secrets be shaped and validated at the launch boundary?
- What belongs in the session index or search surface, if anything?

## Constraint

Do not design this as an abstraction to force into sub-agents. The common operational shape may justify shared tmux or reconciliation primitives, but sessions and processes have different durable truth and failure modes. Design 18 should settle the sub-agent substrate first.
