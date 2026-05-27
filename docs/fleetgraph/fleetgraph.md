# Fleet/FleetGraph AGENT

> **Living document.** This evolves with our Fleet features — update it as each
> capability ships (use cases, triggers, test cases, and architecture decisions),
> rather than treating it as a one-time design doc. When a Fleet feature lands,
> reflect what actually shipped here.

## Agent Responsibility
What does this agent monitor proactively?
    - Proactively, we're watching a Project's 'plan' field. Ship's philosophy states that a plan is a hypothesis about what value it will deliver. Because of the overall value that this hypothesis can add to a retro, the agent judges the quality of the plan and provides tips to improve it. (In this iteration the proactive output is the cached plan-review on the Project Details card; scheduled/no-user-present sweeps are deferred.)

What does it reason about when invoked on demand?
    - The current page's focal entity (a Project or Week) and the context the graph fetches for it: the plan, its associated issues and their statuses, the people/roles on the workspace, and recent activity (standups, comments, status changes). It answers the user's question grounded only in that scoped context, and can diagnose *why* a project looks stuck and recommend a next action.

What can it do autonomously?
    - Read-only reasoning only: it gathers the project/week context (visibility-filtered to what the requesting user can see), runs the proactive plan-review, answers questions, and *drafts* proposed changes. It never executes a write on its own — every mutation is surfaced as a proposal for confirmation first.

What must it always ask a human about before acting?
    - Any state-changing write: creating an issue, patching an issue (status / owner / priority / assignment / edit), or posting a comment. The agent surfaces the fully-resolved change as a confirmable card; nothing is written until the user explicitly confirms in chat, and the write then runs under the user's own permissions and is audited.

Who does it notify, and under what conditions?
    - No one proactively — this iteration is request-triggered (the plan-review renders when the Project page loads; chat runs when the user opens it). Findings are surfaced inline to the requesting user only; there are no external notifications (email/Slack) and no scheduled alerts (deferred to the no-user-present monitoring work).

How does it know who is on a project and what their role is?
    - Through the fetch layer's people/roles read: it reads the workspace's `person` documents joined to `workspace_memberships`, taking the role from `workspace_memberships.role`. The read is scoped by the requesting user's FleetContext/visibility, so the agent never sees people or data the user couldn't.

How does the on-demand mode use context from the current view?
    - The in-page launcher seeds the chat session with the current page's entity (`{ entityId, entityType }`, where a Week maps to a sprint document), so the user doesn't have to restate it. The graph's scope → fetch nodes resolve that entity and pre-load its full context (focal doc + plan, associated issues, people, recent activity) into the prompt, and the answer is grounded in exactly that scope.

Does it poll on a schedule? How frequently?
    - Yes, but only as a low-frequency backstop (hourly, tunable), not the primary path. A periodic
      sweep is required because the highest-value proactive signals are *time-based* and have no
      triggering event — e.g. "no movement in N days," "target_date approaching/passed," or a project
      that was never analyzed. The hash-cache means most swept projects are no-ops, so the sweep is
      cheap; pure high-frequency polling is rejected as wasteful (it diffs every project every tick
      just to catch the few that changed).

Is it triggered by Ship events via webhook?
    - Event-driven is the primary trigger, but "webhook" overstates it — Ship is the system of record,
      so there's no external source to receive webhooks from. Instead, emit INTERNAL domain events when
      a relevant field changes (plan edited, issue status/owner changed, standup/comment posted) from
      the existing mutation service paths (issues-service, comments-service, document-crud) — via an
      outbox table or pg LISTEN/NOTIFY — and enqueue a scoped re-analysis for the affected project.
      This gives the brief's <5-min detection latency without polling, and naturally debounces by
      coalescing bursts per project.

Is it a hybrid of both?
    - Yes — and that's the recommendation. Events handle change-driven freshness cheaply and with low
      latency; the scheduled sweep covers time/decay conditions that no event represents and acts as a
      reconciliation safety net if an event is missed. Implementation-wise this needs the deferred
      pieces the plan called out: an EB worker tier (or scheduled task) + a job queue, and a
      service-level FleetContext (no user present) whose visibility is bounded to workspace scope —
      with proactive findings persisted as the deferred `insight` documents rather than written back
      to entities, so the no-write-without-confirmation rule still holds.

## Agent Diagram
[FleetGraph Agent Diagram](fleetgraph-graph.md)

## Use Cases
For each: role, trigger, what the agent detects or produces, and what the human decides.
Status reflects what has actually shipped (this is a living document).

1. **Project Drift Detection** — _shipped (detection + on-demand explanation)_
   - **Role:** PM / Director
   - **Trigger:** on-demand (computed on-read when a project list/detail is viewed). The scheduled sweep is deferred.
   - **Detects:** project has stale plan, no movement on open issues, or rising incomplete work. (Standup/week-doc signals deferred — they're person-scoped.)
   - **Human decides:** ask FleetGraph for root cause (via the drift badge → seeded chat). Acknowledge / snooze / create follow-up are deferred.
2. **Blocked Work Escalation**
   - **Role:** Engineer / Week owner
   - **Trigger:** issue marked blocked, standup mentions blockers, or no movement after N days
   - **Detects:** who owns the blocked item, what it depends on, whether related docs mention a decision or missing input
   - **Human decides:** notify accountable person, draft comment, reassign, or create dependency issue
3. **Plan vs Reality Reconciliation**
   - **Role:** PM / Director
   - **Trigger:** midweek and end-of-week runs
   - **Detects:** planned issues not started, unplanned issues added, scope churn, completed work not reflected in retro
   - **Human decides:** adjust week plan, accept scope change, ask for retro evidence
4. **Resource / Ownership Risk**
   - **Role:** Manager / Director
   - **Trigger:** week creation, issue assignment, scheduled sweep
   - **Detects:** week owner overloaded, person owns multiple risky items, issues assigned to pending/archived people, no accountable owner
   - **Human decides:** rebalance, change owner, split scope
5. **Contextual "What Should I Do Next?"**
   - **Role:** any user
   - **Trigger:** on-demand chat from issue/project/week/program page
   - **Produces:** next action, risk summary, missing context, suggested update, related docs, likely owner
   - **Human decides:** apply suggested edit, open linked docs, post comment, create issue
6. **Standup Intelligence**
   - **Role:** Week owner / Engineer
   - **Trigger:** missing standup, stale standup, standup submitted
   - **Detects:** silence, repeated blockers, mismatch between standup claims and issue movement
   - **Human decides:** ask for update, accept generated summary, escalate blocker
7. **Retro Assistant**
   - **Role:** PM / Engineer
   - **Trigger:** retro page or end-of-week proactive run
   - **Produces:** "you said you would do X; evidence shows Y; mention Z"
   - **Human decides:** accept suggested retro outline or revise

## Trigger Model
Document your trigger model decision - poll, webhook, or hybrid. Explain the tradeoffs and
defend your choice in terms of cost, reliability, and detection latency.

## Test Cases
For each use case above, provide: the Ship state that should trigger the agent, what the agent
should detect or produce, and the LangSmith trace link from a run against that state.

| # | Ship State | Expected Output | Trace Link |
|----|-----------|----------------|------------|
| 1  |           |                |            |
| 2  |           |                |            |
| 3  |           |                |            |

# Architecture Decisions
Document your key architecture decisions and the tradeoffs you considered. Cover: framework choice, node design rationale, state management approach, and deployment model.
