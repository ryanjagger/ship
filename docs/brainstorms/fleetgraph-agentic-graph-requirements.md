---
date: 2026-05-25
topic: fleetgraph-agentic-graph
---

# FleetGraph: Shared Agentic Graph (Proactive + On-Demand)

## Summary

FleetGraph turns Fleet into an agentic graph layer: one LangGraph reasoning graph (scope → parallel fetch → reason → policy → action) serves both the existing proactive plan-review and a new on-demand, context-scoped chat embedded on Project and Week pages. The agent reads project state across document associations, drafts artifacts, and executes real writes behind explicit in-chat confirmation. Conversations and insights persist as backing-store Ship documents (not shown in the UI).

---

## Problem Frame

Ship shows teams what is happening; it does not tell them what is wrong or what to do next. Project teams drift — issues go stale, plans aren't testable, work diverges from the plan — and the people responsible are busy and rarely staring at a dashboard when it matters.

The shipped Fleet MVP took the first step: when a user creates or edits a project plan, an LLM judges whether it's a testable hypothesis. But that path is a single-shot structured call — not agentic, with no reasoning graph, no tools, and no ability to act. It cannot answer "why is this stuck?", traverse the relationships between a project and its weeks/issues/people, or take a next action on the user's behalf.

The brief's end-state is a project-intelligence agent with two modes — proactive (the agent pushes findings without being asked) and on-demand (the user pulls, via context-scoped chat) — both running through **one shared graph** where only the trigger differs. This iteration builds that shared graph and puts both modes on it: it migrates the proactive plan-review onto the graph and adds the on-demand chat. The full no-user-present monitoring vision is deferred; this iteration proves the graph, the agentic reasoning, and the act-with-confirmation loop against real Ship data.

---

## Actors

- A1. **Project member (PM / Engineer / Director)**: opens the on-demand chat from a Project or Week page, asks questions, accepts drafts, and approves or declines proposed writes.
- A2. **Plan author**: creates/edits a project plan, triggering the proactive plan-review through the graph.
- A3. **FleetGraph agent**: the LangGraph reasoning graph. Fetches and reasons over Ship state, drafts artifacts, proposes and (on confirmation) executes writes, and persists conversations and insights.

---

## Key Flows

- F1. **On-demand chat (read + draft)**
  - **Trigger:** A1 clicks the FleetGraph button on a Project or Week page.
  - **Actors:** A1, A3.
  - **Steps:** Session seeds with the current route context (entity id, type, page). A1 asks a question. The graph fetches the entity and its associated documents (weeks, issues, people, standups, program) in parallel, reasons, and responds with cited Ship entities and a recommended next action; may produce a draft artifact (status update, comment, standup, retro outline).
  - **Outcome:** A1 has a grounded answer and/or a draft, with no Ship data changed.
  - **Covered by:** R1, R2, R3, R6, R7, R10.

- F2. **On-demand chat with a confirmed write**
  - **Trigger:** During F1, the agent determines a write would help (create issue, post comment, change status/owner) or A1 asks for one.
  - **Actors:** A1, A3.
  - **Steps:** The graph's policy node routes the write to the action node, which **pauses** and presents the proposed write for confirmation. A1 confirms or declines. On confirm, the write executes under A1's own permissions and an audit entry is recorded. On decline, nothing is written and the conversation continues.
  - **Outcome:** Either the write is applied and audited, or it is cleanly abandoned. The conversation document records the proposal and the outcome.
  - **Covered by:** R4, R5, R8, R9, R11, R12.

- F3. **Proactive plan-review through the graph**
  - **Trigger:** A2 creates or edits a project plan (request-triggered, user present).
  - **Actors:** A2, A3.
  - **Steps:** The same graph runs with a proactive entry point: fetch the project + plan + signals, reason about plan testability, emit an insight. No chat session; output is an insight surfaced on the project.
  - **Outcome:** The plan-review result is produced by the shared graph rather than the standalone single-shot call.
  - **Covered by:** R1, R6, R13, R14.

---

## Requirements

**Shared graph**
- R1. A single LangGraph graph implements the pipeline scope/context → parallel fetch → reasoning → policy → output/action. Both proactive and on-demand modes run through it; only the entry trigger and the seeded context differ.
- R2. A scope/context node initializes graph state from the trigger: for on-demand, the route context (entity id, document type, page); for proactive, the plan-review target.
- R3. Fetch nodes gather Ship state in parallel — the focal document and its body, related program/project/week/issue documents via `document_associations`, people/roles, and recent standups/comments/status changes — and avoid redundant queries within a run.
- R6. A reasoning node produces the agent's analysis from fetched state and conversation history; deterministic plan signals (the existing `fleet-checks.ts` checks) feed this node as cheap inputs rather than as user-facing output.
- R13. The proactive plan-review is migrated to run through the shared graph; the standalone single-shot path in `fleet-ai.ts` is no longer the plan-review's execution path.
- R14. The migrated plan-review preserves its existing cached, hash-keyed result contract on the project document so existing consumers (the Project Details card, the retro panel) keep working.

**Autonomy & tools**
- R4. A policy node classifies each candidate output by risk: low-risk (answer, draft, insight) proceeds autonomously; any write to Ship (create/close issue, post comment, change status/owner/priority/assignment, edit document content) is routed to the action node for confirmation.
- R5. The action node implements human-in-the-loop: a proposed write pauses the graph and surfaces the proposal in chat; the graph resumes only on explicit user confirmation and abandons the write on decline.
- R7. The agent exposes **read tools** covering the entities reachable from a Project or Week context (focal document, associations, people, standups, status/history).
- R8. The agent exposes **write tools** for the confirmable mutations in R4. Each write tool is a discrete, confirmable action.
- R9. Write tools execute under the requesting user's own permissions — the agent can perform only mutations the user could perform directly — and never bypass existing authorization.

**Context-scoped chat surface**
- R10. The on-demand chat is embedded on Project and Week pages, opened from an in-page control, and seeded with the current page's context so the user does not restate what they're looking at. It is not a standalone, route-agnostic chatbot.
- R11. Chat responses stream to the user. (Transport — reuse the existing WebSocket server vs. SSE — is deferred to planning; see Outstanding Questions.)

**Persistence & audit**
- R12. Agent-initiated writes are recorded in an audit trail capturing who approved, what changed, when, and that the change was agent-initiated.
- R15. A FleetGraph conversation is persisted as a backing-store document (a dedicated `document_type`) associated via `document_associations` to the entity it discussed. Conversation documents are **not** surfaced in Ship's navigation, sidebars, or 4-panel editor; they exist for persistence, resume, and association only.
- R16. The paused-graph state needed to resume a confirmed write across the request round-trip is persisted durably (candidate home: the conversation document; exact checkpoint mechanism deferred to planning).
- R17. Proactive insights are persisted as Ship documents (consistent with R15's document-model approach), associated to the entity they concern.

**Provider & availability**
- R18. The graph requires a configured AI provider. When `FLEET_AI_PROVIDER=none`, all Fleet/FleetGraph features (plan-review and chat) are unavailable rather than degrading to deterministic output. The agent uses the existing provider configuration (`openai` | `anthropic`).
- R19. On-demand chat carries a per-user cost guard consistent with the shipped Fleet rate-limiting posture.

**Testing**
- R20. Tests mock at the model boundary: a scripted fake chat model drives the graph so CI runs keyless, deterministic, and at no AI cost. Graph tests assert orchestration (node transitions, tool invocation, the confirmation pause, resume-on-confirm, abandon-on-decline, conversation/insight/audit persistence). Tools and their authorization are tested directly against Postgres without an LLM. The former `FLEET_AI_PROVIDER=none` "deterministic fallback" assertions are repurposed to assert feature unavailability.

---

## Acceptance Examples

- AE1. **Covers R5, R8, R12.** Given the chat is open on a Project page and the agent proposes creating an issue, when the user confirms, the issue is created under the user's permissions and an audit entry records the agent-initiated write; when the user declines, no issue exists and the conversation continues.
- AE2. **Covers R9.** Given a user who lacks permission to change an issue's owner, when the agent attempts that write on their behalf, the write is rejected by the same authorization that would reject the user directly.
- AE3. **Covers R10.** Given the chat is opened on a Week page, when the user asks "are we on track?", the agent answers about that specific week without the user having to identify it.
- AE4. **Covers R18.** Given `FLEET_AI_PROVIDER=none`, when a user opens a Project page, the FleetGraph chat and plan-review are unavailable (not a deterministic fallback).
- AE5. **Covers R13, R14.** Given a user edits a project plan with a provider configured, when the plan-review runs, it is produced by the shared graph and the Project Details card and retro panel render the result through the existing cached result contract.
- AE6. **Covers R15.** Given a completed chat session, when an agent or query inspects Ship's normal navigation/sidebars, the conversation document does not appear there, but it is retrievable as a backing-store document associated to the discussed entity.

---

## Success Criteria

- A user on a Project or Week page can ask a context-scoped question and get an answer grounded in that entity's associated documents, plus a recommended next action — without restating context.
- The agent can take a real action (e.g., create an issue, post a comment) end-to-end behind a confirmation the user explicitly approves, with the change audited.
- Both the proactive plan-review and the on-demand chat demonstrably run through the same graph; adding a future trigger would not require a second graph.
- CI remains keyless and deterministic; a downstream implementer can run the full suite with no provider and no cost, and the graph's orchestration is covered by scripted-model tests.
- The shipped plan-review's user-facing behavior (the card and retro panel) is unchanged for a user with a provider configured.

---

## Scope Boundaries

- No-user-present proactive mode: scheduled sweeps, event/webhook triggers, and the <5-minute detection-latency goal are deferred. Proactive stays request-triggered (plan create/edit) this iteration.
- The infrastructure that no-user-present mode would require — a background worker / EB worker tier, a scheduler, and service-level (sessionless) authentication — is out of scope.
- Chat surfaces beyond Project and Week (Issue, Program, Person/Team pages) are deferred.
- The cross-project manager digest / project-intelligence ranking view is deferred.
- External notifications (email, Slack) are out of scope.
- A deterministic no-provider fallback for the plan-review is explicitly dropped (see R18) — not deferred, removed for this iteration's unified-graph design.

---

## Key Decisions

- **Graph-first, both modes this iteration**: build the shared graph and route the existing plan-review through it now, rather than building chat first and converging later. Honors "one graph" immediately at the cost of refactoring shipped, working code.
- **Full confirmed-writes autonomy**: exercise the whole graph including the action node and human-in-the-loop, not read/draft-only. Most complete agentic proof; each write tool needs a confirmation surface and audit.
- **Graph requires a provider**: accept regressing the shipped "works with no key, zero AI cost" guarantee in exchange for a single unified agentic graph (R18).
- **Conversations and insights are backing-store documents**: keep "everything is a document" without adding a new content table, but hide them from the UI since a transcript is not something a user edits in the 4-panel editor (R15, R17).
- **Tests mock at the model boundary**: scripted fake model for graph orchestration; direct-against-Postgres tests for tools and authorization; keyless, deterministic CI (R20).
- **Writes run under the user's own permissions** with an audit trail: agent-native parity without privilege escalation (R9, R12).

---

## Dependencies / Assumptions

- Introduces a graph-orchestration dependency (LangGraph.js) running in-process in the Express API; no new process or deployment this iteration.
- Reuses the existing provider configuration and SDK abstraction (`openai` | `anthropic`) for the graph's model calls.
- Relies on the existing `documents` + `document_associations` model for conversations and insights; assumes a new `document_type` value is acceptable (no new table).
- Assumes the existing plan-review's cached result contract on the project document can be produced by the graph without changing what the Project Details card and retro panel read.
- Assumes request-triggered execution (both modes in-process, user present) is sufficient to prove the iteration; the latency/scheduling goals belong to the deferred proactive work.

---

## Outstanding Questions

### Resolve Before Planning

- (none — product scope is settled.)

### Deferred to Planning

- [Affects R11][Technical] Chat streaming transport: reuse Ship's existing WebSocket collaboration server, or add SSE over a dedicated endpoint? The collab WS is specialized for the Yjs sync protocol; weigh coupling vs. adding a transport.
- [Affects R16][Technical] Paused-graph checkpoint mechanism for confirmed-write resume: ride on the conversation document, use LangGraph's own checkpointer, or a Ship-native store? LangGraph's default Postgres checkpointer would create its own tables — reconcile against "no new tables."
- [Affects R20][Needs research] Fake-model test harness shape for LangGraph.js: how to inject a scripted chat model that returns deterministic tool-call sequences across the graph's nodes.
- [Affects R7, R8] Concrete tool inventory and signatures for the Project/Week context (which reads, which writes), mapped onto existing API operations/services for agent-native parity.
- [Affects R1, R13] Whether the proactive and on-demand modes share node implementations wholesale or branch at the policy/output nodes, given proactive emits an insight and on-demand streams a chat turn.
