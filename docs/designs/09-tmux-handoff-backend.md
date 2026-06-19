# 09 — Tmux handoff backend

## Status

Deferred

## Decision Summary

Explore adding tmux as a second background handoff launch backend alongside Ghostty, so `session_handoff` can create reviewed child sessions inside tmux panes when Ghostty is unavailable or undesired.

## Problem Statement

The first `session_handoff` tool design is intentionally Ghostty-only because Ghostty provides a macOS AppleScript split API. Tmux could offer similar split-pane semantics in terminal-agnostic environments, but it needs separate backend discovery, target-pane identity, command construction, and focus behavior decisions.

## Goals

- Record the future direction without expanding the Ghostty handoff tool scope.

## Non-Goals

- Implement tmux support now.
- Design the full tmux backend contract now.

## Design Decisions

### 1. Keep tmux out of the first handoff tool implementation

Tmux is plausible, but it is not the same feature as Ghostty support. It should be a later backend behind the same handoff orchestration primitives once the Ghostty path is stable.

## Implementation Plan

- [ ] Phase 1: Future tmux backend design
  - Goal: Decide whether tmux should become a first-class handoff launch backend.
  - Files: A future accepted design doc.
  - Work: Investigate pane targeting, cwd handling, model inheritance, focus behavior, and fallback ordering.
  - Validation: Prototype manually in a tmux session before committing to an API.
