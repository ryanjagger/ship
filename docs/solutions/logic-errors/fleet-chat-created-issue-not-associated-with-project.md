---
title: Fleet chat created an issue with no project association, so it never showed under the project
date: 2026-05-26
category: docs/solutions/logic-errors
module: fleetgraph
problem_type: logic_error
component: assistant
symptoms:
  - Issue created via Fleet chat ("add an issue to this project") never appears under the project
  - The assistant confirms success ("Done — created the issue") but the issue is orphaned
  - The new issue exists in the documents table but has zero document_associations rows
root_cause: missing_association
resolution_type: code_fix
severity: medium
tags: [fleetgraph, chat, langgraph, belongs-to, associations, reason-node, assistant]
---

# Fleet chat created an issue with no project association, so it never showed under the project

## Problem

While scoped to a project, asking Fleet to "add an issue named X" created the issue
successfully (correct title, priority, assignee) but left it with **no association to the
project**. The issue existed but rendered nowhere — an issue appears under a project only
via a `document_associations` row, and none was written.

## Symptoms

- User adds an issue through Fleet chat, confirms the proposal, sees "Done — created the issue (id: …)".
- The issue does not appear under the project (or anywhere the project's issue list is shown).
- In the DB, the new issue row exists but has **zero** `document_associations` rows.

## What Didn't Work

Nothing was tried-and-failed in code — the bug was found by **reading a LangSmith trace**
(thread `c139bca3-…`). The confirmation trace's `action` node showed the mutation
succeeded with status 201 but `executed.body.belongs_to` was `[]`, despite the agent being
scoped to the focal project. That pointed straight at the proposal args, not the DB write.
(See `../tooling-decisions/langsmith-two-tier-tracing-for-fleet.md`.)

## Solution

`belongs_to` was entirely model-supplied. The model called `propose_create_issue` with
title/priority/assignee but **omitted** `belongs_to`; the action node passed it through as
`args.belongs_to ?? []`; and `createIssueCore` only writes associations when the array is
non-empty (`if (belongs_to.length > 0)`). Result: an orphaned issue.

Fix: default `belongs_to` to the **focal entity** the agent is scoped to, applied at
**proposal-build time** so the surfaced proposal, the approved `contentHash`, and the
executed write all agree (the parity invariant — injecting at execute time would fail the
hash check and bypass the confirmation UI).

```ts
// write.ts — buildCreateIssueProposal now accepts an optional focal default
export function buildCreateIssueProposal(rawArgs: unknown, focalDefault?: FocalAssociation): WriteProposal {
  const args = createIssueArgsSchema.parse(rawArgs);
  // Default association to the focal entity when the model supplied none.
  if (focalDefault && (!args.belongs_to || args.belongs_to.length === 0)) {
    args.belongs_to = [{ id: focalDefault.id, type: focalDefault.type }];
  }
  return makeProposal('create_issue', args, `Create issue: "${args.title}"`, null);
}
```

```ts
// reason.ts — pass the focal entity (its document_type is a valid belongs_to type)
const focalDefault: FocalAssociation | undefined = fetched.focal
  ? { id: fetched.focal.id, type: fetched.focal.documentType } // 'project' | 'sprint'
  : undefined;
proposal = buildProposalFor(writeCall.name, writeCall.args, focalDefault);
```

An explicit model-supplied association is never overridden.

## Why This Works

The focal entity's backing `document_type` (`project` for a project, `sprint` for a week)
is itself a valid `belongs_to` relationship type, so the scoped entity can be used directly
as the default association. "Add an issue [to this project I'm looking at]" is the obvious
intent of a write issued while scoped to one project — making that the deterministic default
means the issue is linked even when the LLM forgets the field.

Crucially, the default is baked into `args` **before** `hashProposal`, so the proposal the
user confirms is the one that executes. A late inject at execute time would either trip the
`contentHash` integrity check or silently diverge from what the user approved.

## Prevention

- **Never rely on the model to supply context the server already knows.** When an agent is
  scoped to an entity, derive associations (and similar contextual fields) from that scope
  deterministically; treat model-supplied values as optional overrides, not the source of
  truth. This is the same lesson as the sibling "assign to me" bug
  (`./fleet-chat-cannot-resolve-assign-to-me.md`) — but note the **deliberate contrast**:
  that one was fixed by enriching the prompt, this one by a server-side default. Prefer a
  deterministic default over a prompt instruction when the value is knowable server-side; a
  prompt nudge is belt-and-suspenders, not the safeguard.
- **Apply defaults at proposal-build time, not execute time**, in any HITL/confirm-then-apply
  flow with a content hash. The surfaced, hashed, and executed args must be identical.
- Unit-test the proposal builder directly. `write.test.ts` now asserts the default is applied
  when omitted, maps a focal week → `sprint`, does **not** override an explicit association,
  is a no-op with no focal, and produces a `contentHash` equal to the explicit-association form:
  ```ts
  const p = buildCreateIssueProposal({ title: 'X', priority: 'high' }, { id: focal, type: 'project' });
  expect((p.args as any).belongs_to).toEqual([{ id: focal, type: 'project' }]);
  ```
- **Trace real conversations.** Like the sibling bug, a "the write succeeded but nothing
  shows" defect is nearly invisible to code review and obvious from a trace transcript.

## Related Issues

- `./fleet-chat-cannot-resolve-assign-to-me.md` — sibling fleetgraph-chat correctness bug in the same proposal/prompt surface; **contrasting fix** (prompt enrichment vs server-side default)
- `../tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — the observability that surfaced this bug
- `../integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md` — the other Fleet AI learning (same module surface)
