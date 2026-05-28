# PRESEARCH

The goal is to make informed decisions about your agent's responsibilities and architecture.

> Status legend: **[shipped]** = built in the current iteration; **[deferred]** = designed-for, not yet built.

---

## Phase 1: Define Your Agent

### 1. Agent Responsibility Scoping

- **What events in Ship should the agent monitor proactively?**
  Primary signal is a Project's `plan` — Ship treats a plan as a hypothesis about value, so the agent judges its quality and suggests improvements. The fuller target is *project drift*: stale plan + active issues + no recent standups + slipping week docs + rising incomplete work. **[shipped]** the plan-review only; **[deferred]** event-driven monitoring of issue-state/association/standup/plan-retro-approval changes.

- **What constitutes a condition worth surfacing?**
  A material risk to the bet that a human should act on, paired with *evidence* and a *recommended next action* — e.g. the plan isn't a testable hypothesis (missing what-changes / for-whom / by-how-much / by-when), a project is stuck (stalled issues + stale plan + no movement), blocked work, plan-vs-reality divergence, or an ownership gap. The bar is "actionable + explainable," not raw metrics or noise.

- **What is the agent allowed to do without human approval?**
  Read-only reasoning only: gather visibility-scoped context, score/explain the plan, answer questions, and *draft* proposals. **[deferred]** it may also create/resolve `insight` records and notify the single directly-responsible user in-app. It never performs a state-changing write on its own.

- **What must always require confirmation?**
  Every state-changing write: create issue, patch issue (status / owner / priority / assignment / edit), post comment — and (future) edit doc/plan/retro, change ownership, generate a manager-facing summary about a person, or anything external (email/Slack). Surfaced as a confirmable proposal; the write then runs under the user's own permissions and is audited.

- **How does the agent know who is on a project?**
  Via the fetch layer's people/roles read: `person` documents joined to `workspace_memberships`, with the role taken from `workspace_memberships.role` (and, later, RACI/accountability fields). The read is bounded by the requesting user's `FleetContext`/visibility.

- **How does the agent know who to notify?**
  **[shipped]** it doesn't currently — findings are surfaced inline to the requesting user only. **[deferred]** for clear accountability items it would notify the accountable owner (issue assignee → week owner → project owner) in-app; broader stakeholder notification always requires confirmation.

- **How does the on-demand mode use context from the current view?**
  The in-page launcher seeds the session with `{ entityId, entityType }` (a Week maps to a `sprint` doc), and the graph's scope → fetch nodes pre-load that entity's full context into the prompt, so the user never restates it and the answer is grounded in exactly that scope.

### 2. Use Case Discovery

Role · trigger · what the agent detects/produces · what the human decides:

1. **Plan-quality review** **[shipped]** — *PM/Director* · Project page load (cached on `properties.fleet`) · whether the plan is a testable hypothesis (what changes / for whom / by how much / by when) + a one-line "why it's stuck" diagnosis · accept the plan or apply the suggested rewrite.
2. **Contextual "what needs attention / what should I do next?"** **[shipped]** — *any user* · on-demand chat from a Project/Week page · grounded answer + risk/why-stuck summary + suggested next action, and can *propose* a write · confirm the write, act, or open linked docs.
3. **Project drift detection** **[deferred]** — *PM/Director* · scheduled sweep or issue/week change · active issues + stale plan + no recent standups + slipping week docs · acknowledge, snooze, ask for root cause, or create follow-up work.
4. **Blocked-work escalation** **[deferred]** — *Engineer/Week owner* · issue marked blocked / standup mentions a blocker / no movement after N days · who owns it, what it depends on, whether a decision/input is missing · notify the accountable person, draft a comment, reassign, or create a dependency issue.
5. **Plan-vs-reality reconciliation** **[deferred]** — *PM/Director* · midweek + end-of-week runs · planned issues not started, unplanned issues added, scope churn, completed work missing from the retro · adjust the week plan, accept scope change, or ask for retro evidence.
6. **Resource / ownership risk** **[deferred]** — *Manager/Director* · week creation, issue assignment, sweep · overloaded week owner, issues assigned to pending/archived people, no accountable owner · rebalance, change owner, split scope.
7. **Standup & retro intelligence** **[deferred]** — *Week owner/Engineer/PM* · missing/stale/submitted standup or the retro page · silence, repeated blockers, claim-vs-issue-movement mismatch; "you said X, evidence shows Y" · ask for an update, accept the generated summary/retro outline, or escalate.

### 3. Trigger Model Decision

- **When does the proactive agent run without a user present?** **[deferred]** A hybrid: event-driven on relevant mutations (plan edit, issue state/owner change, standup/comment, plan/retro approval) plus a low-frequency scheduled sweep for time-based conditions. Both fire the *same* compiled graph; only the trigger differs.
- **Poll vs. webhook vs. hybrid — tradeoffs?** Pure polling is simple but wasteful (diffs every project each tick) and trades latency against cost. "Webhooks" overstates it — Ship is the system of record, so it's *internal* domain events (outbox or `LISTEN/NOTIFY`), which are cheap and low-latency but blind to time-based decay. Hybrid gets event freshness + a sweep that covers deadline/staleness conditions and acts as a missed-event safety net.
- **How stale is too stale?** Change-driven signals target the brief's **< 5 min**; time-based conditions (deadline approaching, N-days-no-movement) tolerate an hourly sweep; the on-view plan-review is fine served from the hash cache until its inputs change.
- **What does the choice cost at 100 / 1,000 projects?** The sweep runs cheap **SQL detectors** first and invokes the model only for candidates whose input-hash actually changed, so spend scales with *changes*, not project count. At 1,000 projects an hourly sweep is mostly no-ops (hash hits); the cost is a handful of model calls per cycle plus bounded SQL.

---

## Phase 2: Graph Architecture  *(this phase is **[shipped]**)*

### 4. Node Design

- **Nodes:** `scope` (seed state from the trigger input, resolve `FleetContext`, map Week→sprint) → `fetch` (parallel reads) → `reason` (two-tier: proactive = `fleet-ai.ts` structured plan-review with `fleet-checks` signals; chat = bound chat model that may emit a `propose_*` tool call) → conditional edge → `action` (HITL `interrupt`) **or** `output`.
- **Parallel fetch:** one consolidated traversal (`Promise.all`) pulls the focal doc + body, associations (program/project/week/issues), people/roles, and recent activity (standups/comments/status changes) in parallel and merges via a replace reducer — no per-entity N+1.
- **Conditional edges:** a single conditional edge after `reason` keyed on the resolved `proposal` — a write proposal routes to `action` (which calls `interrupt(proposal)` and executes only the confirmed args on resume); anything else (answer, plan-review, draft) routes to `output`. (The original named "policy" node was collapsed into this edge.)

### 5. State Management

- **Per-session state:** an `Annotation` graph state — `messages` (append reducer), the fetched context snapshot (replace), and `analysis`/`proposal` (replace).
- **Persisted between runs:** the proactive plan-review caches hash-keyed on `properties.fleet`; a chat's paused-write state persists as a custom JSONB checkpoint on the conversation document (`properties.fleetgraph_checkpoint`), and the transcript on `properties.fleetgraph_transcript` — each a disjoint single-statement `jsonb_set` so they never clobber each other.
- **Avoiding redundant calls:** consolidated traversal (no N+1), the input-hash cache (skip the model when inputs are unchanged), the read context pre-fetched once into the prompt (so the chat model answers in one turn with no per-tool round trips), and clearing the checkpoint after each resolved turn so a fresh turn starts clean.

### 6. Human-in-the-Loop Design

- **Which actions require confirmation:** all writes — create/patch issue, post comment (and future doc/plan/retro edits, ownership changes, notifications).
- **Confirmation experience:** the chat drawer renders the proposal as a **structured card** (action verb + target entity + each field being set), not raw JSON; the user clicks Confirm or Decline. The exact surfaced args are what execute on resume (parity backed by a content hash).
- **Dismiss / snooze:** Decline abandons the proposal — the graph resumes with `{approved:false}`, no write occurs. A pending proposal **persists server-side** and re-surfaces if the user navigates away and reopens the drawer, so it's never silently lost. (**[deferred]** insight-level snooze/auto-resolve when the underlying condition clears.)

### 7. Error and Failure Handling

- **Ship/provider down:** the model boundary **never throws** — SDK errors, refusals, and truncation map to a neutral result; graph errors degrade to a neutral output without orphaning a paused checkpoint; the SSE turn aborts cleanly on client disconnect.
- **Graceful degradation:** with no AI provider, the plan-review reports *unavailable* (no deterministic user-facing fallback) and the chat launcher hides itself rather than rendering a dead control.
- **What's cached, how long:** `properties.fleet` plan/retro results — hash-keyed, valid until inputs change or a force-refresh; the conversation checkpoint — latest-tuple only, deleted once the turn resolves (kept only while a write is pending); the per-user rate-limit — in-memory, per-process, resets on restart (a documented residual; a Postgres-backed counter is the durable upgrade).

---

## Phase 3: Stack and Deployment

### 8. Deployment Model

- **Where the proactive agent runs:** **[shipped]** in-process inside the Express API on Elastic Beanstalk — request-triggered, no separate worker. **[deferred]** the no-user-present mode runs on an EB **worker tier** (or scheduled task) + a job queue, executing the *same compiled graph*.
- **Kept alive:** by the EB process/worker tier (the graph compiles once, lazily, over the eagerly-initialized pg pool).
- **Auth without a user session:** **[shipped]** every request carries the user's session → `FleetContext`, and writes run under that user. **[deferred]** the proactive worker uses a **service-level principal** with a `FleetContext` bounded to workspace scope (not a user session); it persists findings as `insight` documents and performs no entity writes, so the no-write-without-confirmation rule still holds.

### 9. Performance

- **Achieving < 5-min detection latency:** event-driven re-enqueue on the triggering mutation gives near-real-time freshness; a ≤5-min sweep covers time-based conditions; cheap SQL detectors gate the expensive model call so latency isn't spent on no-ops.
- **Token budget per invocation:** proactive = one structured call (Haiku-class default) over a compact `<plan>` + `<signals>` prompt; chat = one bound model turn over the pre-fetched context. Both small in the common case; transcript history is the variable that grows.
- **Cost cliffs:** (1) unbounded conversation transcript / fetched-snapshot size inflating the prompt and the checkpoint blob; (2) fan-out fetch on very large projects (many issues) bloating context; (3) the cache-miss double-fetch (`gatherSignals` + the graph's own fetch). Mitigations: the input-hash cache, SQL-detector gating before AI, and bounding/limiting the fetched lists.
