---
title: Fleet chat couldn't resolve "assign to me" because the prompt omitted the current user
date: 2026-05-26
category: docs/solutions/logic-errors
module: fleetgraph
problem_type: logic_error
component: assistant
symptoms:
  - '"assign to me" / "my issues" make the assistant repeatedly ask the user to identify themselves'
  - The model claims it does not know who the user is despite a known session userId
  - Conversation spirals over many turns; the model re-introduces itself and loses the goal
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [fleetgraph, chat, system-prompt, identity, langgraph, reason-node, assistant]
---

# Fleet chat couldn't resolve "assign to me" because the prompt omitted the current user

## Problem

In Fleet chat, asking the assistant to "create an issue and assign it **to me**" was
effectively unanswerable. The model repeatedly asked the user to identify themselves and
never bound "me" to a real user id, turning a one-shot request into a 12-turn spiral before
it finally worked.

## Symptoms

- "assign to me" / "my issues" → the model replies it doesn't know who the user is.
- It can name the user only when the user *types* their name (pattern-matching the roster),
  but still can't bind the first-person reference.
- Across turns it loses the established goal and re-introduces itself ("I'm Fleet…").

## What Didn't Work

- Nothing was "tried and failed" in code — the bug was found by **reading a LangSmith
  trace** of a real conversation (thread `5e835209-…`, 13 turns). The transcript made the
  failure obvious: every turn's input carried `ctx.userId`, yet the model kept asking "who
  are you?". That ruled out checkpointing/state loss (all 13 turns shared the thread) and
  pointed straight at prompt content. (See `../tooling-decisions/langsmith-two-tier-tracing-for-fleet.md`.)

## Solution

`buildChatSystemPrompt` in `api/src/services/fleetgraph/nodes/reason.ts` injected the
**people roster** but never told the model **which person the speaker is**. `ctx.userId`
was in graph state but never reached the prompt. Fix: resolve `ctx.userId` against the
roster and add a `current_user` line plus an explicit resolution instruction.

```ts
// reason.ts — buildChatSystemPrompt now takes the current user id
const me = currentUserId ? people.find((p) => p.userId === currentUserId) : undefined;
const currentUser = me
  ? `${me.name}(${me.userId})`
  : currentUserId
    ? `(${currentUserId}; not in the project roster)`
    : '(unknown)';

// ...added to the prompt:
'When the user refers to themselves ("me", "my", "myself", "I", "assign to me"), ' +
'resolve it to current_user below — do NOT ask who they are.',
// ...inside <context>:
`current_user: ${currentUser}`,
```

Call site passes the id: `buildChatSystemPrompt(fetched, ctx.userId)`.

## Why This Works

The roster gave the model the set of *possible* assignees but no anchor for the indexical
"me". An LLM cannot infer the speaker's identity from a list — it needs the binding stated.
Adding `current_user` (resolved server-side from the authenticated `ctx.userId`) plus an
instruction to resolve self-references removes the ambiguity at the source. Resolving
server-side, not asking the model to guess, also keeps assignment tied to the actual
authenticated user rather than a name the model pattern-matched.

## Prevention

- **When a prompt lists entities the model must act on, also state the user's own identity**
  if any request can be first-person ("me", "my", "mine"). A roster without a "who am I"
  anchor is an incomplete prompt.
- Unit-test prompt builders directly. `reason.test.ts` now asserts `current_user` is present
  for an in-roster user, the bare-id fallback for a non-roster user, `(unknown)` when no id,
  and that the resolve-self-reference instruction is present:
  ```ts
  expect(buildChatSystemPrompt(fetched(), 'user-dev')).toContain('current_user: Dev User(user-dev)');
  expect(buildChatSystemPrompt(fetched(), 'user-dev')).toMatch(/do NOT ask who they are/i);
  ```
- **Trace real conversations.** This class of bug (the model behaving "dumbly" because of a
  prompt omission) is nearly invisible from code review but obvious from a trace transcript.

## Related Issues

- `../tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — the observability that surfaced this bug
- GitHub #32 — sibling fleetgraph-chat correctness bug (conversation/entity isolation in `routes/fleetgraph.ts` + a missing React `key`). **Different root cause** — request/state binding, not prompt content. Do not conflate.
- `../integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md` — the other Fleet AI learning (same module surface, structured-output layer)
