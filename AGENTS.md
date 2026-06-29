# AGENTS.md

`pi-sessions` exists to make prior work in the pi coding agent discoverable and useful. It acts as some form of "memory" across sessions, enabling one session to learn from other sessions through a combination of tools and bookkeeping. It also provides some session management capabilities to make it easier and more ergonomic to work across sessions. This primarily takes shape in the form of the following features:

- indexing of all session data in a searchable FTS5 SQLite database, and providing pi and the user with a tool to search it
- instead of simply loading the session into context, enable pi to ask a session questions and get targeted answers
- auto-authoring a title for every session as a high-level summary of what is within that session
- handing off a task to a new session; instead of simply starting a new session from blank, or compacting, start a new session with specific instructions and context that comes from the previous session

## Project context

See @CONTEXT.md for project vocabulary.

## Ethos

This originally started as inspiration from the Amp coding agent, which at one point offered similar versions of these tools: session search/ask, handoffs, titles. It has since evolved to encompass my ideas of how we can expand beyond the scope of a single session. To talk through some of those:

- As models have gotten better, they have actually been able to work well even across compactions. So I can continue on the same task for extended periods of time with success. However, there are times when I genuinely want to start a NEW task, or maybe I want to spin off a side task that is tangential but not directly involved in my current one. That is where I find value in the handoff: there is context within this session that is relevant to a new task, so let's make sure to impart that information so that the new session starts off with the best source of information
- It seems straightforwardly obvious to me that some of the most useful information in an agent-driven codebase are the sessions themselves. Obviously, the code is quite important, but the reason why that code is written is equally if not more important, and being able to surface that information allows for more informed decisions.

## Core principles

- Build on pi-native concepts, types, and extension APIs where available; read pi source when helpful
- Keep clear abstraction between features, utilizing the shared folder for overlap
- Prioritize ergonomics of the exposed interaction surface over internal implementation

## Code style

See @DEV.md for code style and development commands.
