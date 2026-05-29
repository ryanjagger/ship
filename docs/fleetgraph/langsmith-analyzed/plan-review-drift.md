# FleetGraph trace analysis — proactive plan-review (drift mode)

**Trace:** `019e7031-a4ff-7647-a3ba-6fcdccfde8db`
**Thread:** `a1969eb5-b9fb-4bf7-abc4-f45a3e9d26dc`
**Project (LangSmith):** `fleet`
**Duration:** 1.75 s · **Status:** success
**Mode:** `drift` (proactive plan-review triggered by a background sweep, not a user chat)

This thread is a single **FleetGraph** run — Ship's LangGraph agent. It ran in
proactive drift mode, evaluating a drift signal on the "Infrastructure" project
and deciding whether to surface it.

## The graph

FleetGraph is **one compiled `StateGraph`** with five nodes and a single
conditional branch (`api/src/services/fleetgraph/graph.ts:92`):

```
START → scope → fetch → reason ─┬─ policyRoute=='output' → output → END
                                └─ policyRoute=='action' → action → END
```

Both entry modes (proactive sweeps *and* interactive chat) share `scope` +
`fetch` wholesale. The `reason` node branches **internally** by mode, and the
conditional edge after it (`policyRoute`, a pure function — there is no separate
policy node) routes on whether a write was proposed.

## What this specific trace did

The four nodes that executed (`action` was skipped):

| Node | Time | What it did |
|------|------|-------------|
| **`scope`** | ~0 ms | Validated the seeded context (admin user, workspace `a76cefbe…`, `entityType: project`, `mode: drift`). No chat message to seed in proactive mode, so output is empty. |
| **`fetch`** | ~30 ms | Pulled a visibility-filtered snapshot of the focal **project** (`4158e83b…`): its program ancestor ("Infrastructure"), 2 child issues (one `in_progress`, one `todo`), the active "Week 14" sprint, plus standup/body context. |
| **`reason`** | ~1.69 s | The only LLM call — a single **`ChatAnthropic`** invocation. In proactive mode it emits a *structured* drift review rather than free text. |
| **`output`** | ~0 ms | Wrapped the reasoning into the final `answer`. |

**The branch:** the input carried a `driftSignals` entry —
`rising_incomplete_work` ("incomplete work +2 in 7d"). Because `drift` mode
produces an insight and **no write proposal**, `policyRoute` returned
`'output'`, so the graph went `reason → output → END` and never touched the
`action` node (that node only fires in chat when the model proposes a write,
where it would `interrupt()` for approval).

## The decision

The `reason` node returned **`decision: SUPPRESS`**:

> The rising incomplete work signal (+2 in 7d) is consistent with the team's
> stated activity of advancing planned demo work and validating successive
> slices… The standup reports show active progress with no blockers, indicating
> the team is managing the work intentionally rather than experiencing
> uncontrolled scope creep or delivery risk.

So: the background sweep detected a drift signal on the Infrastructure project,
FleetGraph fetched the project's surrounding context, the model judged the
signal benign, and it **suppressed** the alert rather than surfacing it to the
user — a clean `output`-path run with no action taken.

## Note

This thread contains exactly **one** trace. The session has many other
near-identical `LangGraph` runs around the same time (20:04–20:06) — those are
sibling entities from the same proactive sweep
(`sweep_run_id: 0dcccf03-ed51-4a4b-8846-a60ab1102683`), each its own thread.
