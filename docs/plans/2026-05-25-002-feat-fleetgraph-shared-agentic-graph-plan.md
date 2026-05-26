---
date: 2026-05-25
status: active
type: feat
origin: docs/brainstorms/fleetgraph-agentic-graph-requirements.md
---

# feat: FleetGraph — Shared Agentic Graph (Proactive + On-Demand)

## Summary

Introduce a LangGraph.js agentic graph that runs in-process in the Express API and serves both Fleet modes through one pipeline (scope → parallel fetch → reason → policy → action). This iteration migrates the existing single-shot proactive plan-review onto the graph and adds a new on-demand, context-scoped chat on Project and Week pages with read, draft, and confirmed-write autonomy (human-in-the-loop). Conversations persist as hidden backing-store documents; the confirmed-write resume state persists via a custom checkpointer on that conversation document. The graph requires a configured AI provider.

Origin requirements: `docs/brainstorms/fleetgraph-agentic-graph-requirements.md`.

---

## Problem Frame

Ship shows teams what is happening but not what is wrong or what to do next. The shipped Fleet MVP (`api/src/services/fleet-ai.ts` + `fleet-service.ts`) judges plan testability via a single structured-output call — no reasoning graph, no tools, no ability to act or to answer "why is this stuck?". The brief's end state is a project-intelligence agent with proactive and on-demand modes sharing one graph (trigger differs, graph doesn't). This iteration builds that shared graph, routes the existing plan-review through it, and adds the on-demand chat — proving the graph, the agentic reasoning, and the act-with-confirmation loop against real Ship data. The no-user-present monitoring vision (scheduled sweeps, <5-min latency, worker/scheduler/service-auth) is deferred.

---

## Scope Boundaries

### In scope
- One shared LangGraph graph; both modes run through it (request-triggered).
- Migrate the proactive plan-review onto the graph, preserving its `properties.fleet` cache contract so the Project Details card and retro panel are untouched.
- On-demand chat on Project and Week pages: read tools, draft, and confirmed writes (create issue, patch issue status/owner/priority, post comment) behind explicit in-chat confirmation, executed under the user's own permissions, audited.
- Conversations as hidden backing-store documents; custom JSONB checkpointer on the conversation document.
- Graph requires a provider; features unavailable when `FLEET_AI_PROVIDER=none`.
- SSE streaming for chat turns.
- Model-boundary test seam: scripted fake chat model, keyless/deterministic CI.

### Deferred for later (origin)
- No-user-present proactive mode: scheduled sweeps, event/webhook triggers, <5-min detection latency, and the worker / EB worker tier / scheduler / service-level auth it requires.
- Chat surfaces beyond Project and Week (Issue, Program, Person/Team pages).
- Cross-project manager digest / project-intelligence ranking view.
- External notifications (email, Slack).

### Deferred to Follow-Up Work (plan-local)
- **Insights-as-documents** (origin requirement for persisting proactive findings as documents): not built this iteration. The only proactive output here is the plan-review, which keeps its `properties.fleet` cache contract; a separate insight document type pairs with the deferred no-user-present sweep that generates net-new findings. (Confirmed with user.)
- Adopting LangChain chat models for the proactive structured node (this iteration keeps `fleet-ai.ts` there; chat models are used only for the chat tool-loop).

### Outside this product's identity (origin)
- A standalone, route-agnostic chatbot. The chat is always embedded and context-scoped.

---

## Requirements Trace

Origin requirements (R1–R20) map to units as follows:

| Origin | Where addressed |
|---|---|
| R1 shared graph pipeline | U7 |
| R2 scope/context node | U7 |
| R3 parallel fetch, no redundant queries | U5 |
| R4 policy node risk classification | U7 |
| R5 action node human-in-the-loop | U7, U9 |
| R6 reasoning node; deterministic checks as cheap inputs | U7 (reuses `fleet-checks.ts`) |
| R7 read tools | U5 |
| R8 write tools | U6 |
| R9 writes under user's own permissions | U6 |
| R10 context-scoped chat on Project/Week | U9, U10 |
| R11 streaming responses (SSE) | U9, U10 |
| R12 audit trail for agent writes | U6 |
| R13 migrate plan-review onto the graph | U8 |
| R14 preserve `properties.fleet` cache contract | U8 |
| R15 conversation as hidden backing-store document | U2, U9 |
| R16 paused-graph checkpoint persistence | U3 |
| R17 insights as documents | Deferred to Follow-Up Work |
| R18 graph requires a provider; unavailable when none | U4, U8, U9 |
| R19 chat per-user cost guard | U9 |
| R20 model-boundary test seam | U4 and every unit's test scenarios |

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Graph shape (one compiled graph, two entry inputs):**

```
            ┌──────────── proactive input: { mode:'plan_review', projectId }
trigger ────┤
            └──────────── chat input: { mode:'chat', entityId, entityType, message, history }
                  │
                  ▼
            scope/context node     (seed state from input; resolve FleetContext)
                  │
        ┌─────────┼─────────┐      parallel fetch (fan-out; reducer merges)
        ▼         ▼         ▼
     fetch:doc  fetch:assoc  fetch:people/standups
        └─────────┼─────────┘
                  ▼
            reasoning node         (LLM; fleet-checks signals fed in; produces analysis
                  │                 + for chat, may emit tool calls)
                  ▼
            policy node            (classify outputs: low-risk → output; write → action)
              │        │
   (no write) │        │ (write proposed)
              ▼        ▼
         output node   action node ── interrupt(proposal) ──► [pause; return to caller]
                                          ▲                         │ resume Command({approved})
                                          └──── re-run from top ─────┘
                                       (mutation executes AFTER interrupt; pre-interrupt idempotent)
```

**Provider strategy (two-tier):** the reasoning node for the **proactive plan-review** calls the existing `fleet-ai.ts` structured path (keeps the tested zod-v3/v4 Anthropic workaround). The **chat tool-loop** uses LangChain `ChatOpenAI`/`ChatAnthropic` with `.bindTools()` for clean tool-call/interrupt plumbing. Both gated by `isFleetGraphAvailable()` (U4), which reuses `fleet-ai.ts`'s provider/key resolution.

**Checkpointer:** a thin `BaseCheckpointSaver` storing only the latest checkpoint tuple per `thread_id` into `properties.fleetgraph_checkpoint` on the conversation document — no new tables, durable across the propose→confirm round-trip.

---

## Output Structure

New backend code lives under a `fleetgraph/` service directory:

```
api/src/services/fleetgraph/
├── state.ts            # Annotation-based graph state + types
├── model.ts            # LangGraph model-boundary adapter (chat models + structured + availability)
├── checkpointer.ts     # custom JSONB BaseCheckpointSaver on the conversation doc
├── conversation.ts     # create/read conversation backing-store documents
├── tools/
│   ├── read.ts         # read tools (FleetContext-scoped, visibility-filtered)
│   └── write.ts        # write tools (call shared mutation services; audited)
├── nodes/
│   ├── scope.ts
│   ├── fetch.ts
│   ├── reason.ts
│   ├── policy.ts
│   └── action.ts
├── graph.ts            # StateGraph assembly + compile
└── index.ts            # public entry points: runPlanReview(), runChatTurn(), resumeChatTurn()
```

The per-unit `**Files:**` sections remain authoritative; the implementer may adjust layout.

---

## Implementation Units

### U1. Dependency floor: bump zod, add LangChain stack

**Goal:** Establish the dependency baseline so all later units compile, isolating the repo-wide zod bump in its own change.

**Requirements:** Enables R1–R20 (prerequisite).

**Dependencies:** none.

**Files:**
- `api/package.json` (modify): bump `zod` `^3.24.1` → `^3.25.76` (stays v3); add **pinned** `@langchain/langgraph@^1.3.2`, `@langchain/core@^1.1.48`, `@langchain/openai@^1.4.7`, `@langchain/anthropic@^1.4.0`, and **`@langchain/langgraph-checkpoint@^1.0.2`** (the `BaseCheckpointSaver` source U3 depends on — must be listed explicitly, not assumed transitive).
- `pnpm-lock.yaml` (modify).

**Approach:** Bump zod first and verify before adding LangChain packages. zod stays on v3, so `openai/helpers/zod` and the Anthropic `zodToJsonSchema` workaround in `fleet-ai.ts` are unaffected; this is a minor bump, not the v3→v4 hazard. Note pnpm will install a second copy of `@anthropic-ai/sdk` (bundled by `@langchain/anthropic`) — acceptable. Keep `moduleResolution: NodeNext`; LangGraph subpath exports resolve under it. **Pin all `@langchain/*` versions** (the floors above) so `@langchain/core` resolves to a single deduped version satisfying every package's peer range.

**Patterns to follow:** existing `api/package.json` dependency conventions.

**Execution note:** Land the zod bump and the LangChain additions as separable steps; confirm the zod bump green before building on it.

**Test scenarios:**
- Re-run the existing Fleet AI suite (`api/src/services/fleet-ai.test.ts`) after the zod bump and confirm `openai/helpers/zod` structured parsing and the Anthropic JSON-schema path still pass (this is the most version-sensitive consumer).
- `pnpm type-check` and `pnpm build:shared` succeed across packages after the additions.
- After install, run `pnpm why zod` and confirm a single resolved zod version satisfies every `@langchain/*` peer range; type-check a trivial `import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'` under NodeNext before U3 begins.
- `Test expectation: dependency change — covered by existing suites + type-check, no new behavior.`

**Verification:** All existing api tests pass; type-check clean; LangGraph + checkpoint imports resolve under NodeNext; one deduped zod version.

---

### U2. Migration: conversation document type + association type, hidden from UI

**Goal:** Add the backing-store `conversation` document type and a relationship type linking a conversation to the entity it discussed, without exposing either in the UI.

**Requirements:** R15.

**Dependencies:** none (can run parallel to U1).

**Files:**
- `api/src/db/migrations/045_fleetgraph_document_types.sql` (create): `ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'conversation'`; `ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'insight'` (**reserved now** to avoid a second `ALTER TYPE` migration when the deferred no-user-present sweep builds insights-as-documents — no consumer this iteration); `ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'discusses'` (conversation → entity), following the exact `DO $$ ... EXCEPTION WHEN duplicate_object` idempotency pattern in `api/src/db/migrations/017_standup_sprint_review_types.sql`. The list/by-id/search exclusion applies to both `conversation` and `insight`.
- `api/src/routes/documents.ts` (modify): add an explicit `AND document_type != 'conversation'` to the base list query (which has no allow-list today — it returns all types when no `?type=` filter is passed); the `GET /documents/:id` by-id path and any conversion query must also exclude/deny `conversation` so a caller with an id cannot fetch a transcript via the generic document route.
- **No `migrate.ts` change.** Migration `017` already runs `ALTER TYPE ... ADD VALUE IF NOT EXISTS` inside the runner's per-migration `BEGIN/COMMIT` wrapper and applied successfully — PostgreSQL only forbids `ADD VALUE` in a transaction when the new value is *used* in the same transaction, which 045 does not do.

**Approach:** Both `document_type` and `relationship_type` are Postgres ENUMs; new values require `ALTER TYPE ADD VALUE`. Mirror migration `017`'s pattern exactly (verified to work through the transactional runner). Use a new `'discusses'` relationship type rather than overloading `'parent'`, so conversations never pollute parent-based hierarchy traversals. The list endpoint has no positive allow-list, so hiding `conversation` requires an explicit negative filter — and the generic by-id and search/backlink surfaces (e.g. the trigram search index from migration 038) must be checked too, not just the nav list.

**Patterns to follow:** existing numbered migrations in `api/src/db/migrations/`; the ENUM definitions in `api/src/db/schema.sql`.

**Test scenarios:**
- Migration applies on a fresh DB and is idempotent under the `schema_migrations` tracking (re-run is a no-op).
- After migration, inserting a `documents` row with `document_type='conversation'` succeeds and a `document_associations` row with `relationship_type='discusses'` succeeds.
- `Covers R15.` The base list query (no `?type=` filter) does NOT return `conversation` documents; a `?type=conversation` filter is rejected by query validation (the enum excludes it).
- `Covers R15.` `GET /documents/:id` for a `conversation` document does not return its transcript via the generic route; the search/backlink surfaces likewise exclude it.
- Migration `045` applies cleanly through the existing transactional runner (no runner change) and re-running it is a no-op.

**Verification:** Fresh `pnpm db:migrate` succeeds; conversation docs are insertable but unreachable via list, by-id, and search surfaces.

---

### U3. Custom JSONB checkpointer on the conversation document

**Goal:** Persist the paused-graph state needed to resume a confirmed write, with no new tables.

**Requirements:** R16.

**Dependencies:** U1, U2.

**Files:**
- `api/src/services/fleetgraph/checkpointer.ts` (create): a `BaseCheckpointSaver` subclass storing the latest checkpoint tuple per `thread_id` into `properties.fleetgraph_checkpoint` on the conversation document.
- `api/src/services/fleetgraph/checkpointer.test.ts` (create).

**Approach:** Implement the five abstract methods (`getTuple`, `list`, `put`, `putWrites`, `deleteThread`). Because resume only needs the latest checkpoint (no time-travel/history for this feature), `list` yields the single stored tuple and `put`/`putWrites` upsert into one JSONB blob. Use `thread_id` as the join key to the conversation document. Reuse the `jsonb_set` key-scoped write pattern from `fleet-service.ts`, but **every write — both the checkpointer's `properties.fleetgraph_checkpoint` and U9's transcript appender's `properties.fleetgraph_transcript` — MUST be a single-statement `jsonb_set` on its own disjoint top-level key**, never a read-modify-write of the whole `properties` blob. Otherwise a transcript append and a checkpoint `put` interleaving on the same conversation-doc row will clobber each other (a lost checkpoint orphans the paused write; a lost transcript corrupts history). Do not bump `updated_at`. Serialize the checkpoint with LangGraph's serializer protocol.

**Concurrency contract:** the latest-tuple-only design is correct only if turns on a single `thread_id` are serialized. A second chat turn fired on the same conversation while a write proposal is still pending would overwrite the paused checkpoint and discard the first proposal's pending writes. U9 must enforce one in-flight turn per conversation (reject/queue a second turn while a proposal is pending) — state this as a precondition the checkpointer relies on.

**Patterns to follow:** the `jsonb_set` cache-write in `api/src/services/fleet-service.ts`; the `BaseCheckpointSaver` interface (`@langchain/langgraph-checkpoint`).

**Execution note:** Test-first — the saver's contract (round-trip a tuple, overwrite-latest, resume after a simulated process boundary) is well-defined and best pinned before the graph depends on it.

**Test scenarios:**
- `put` then `getTuple` round-trips a checkpoint tuple for a `thread_id`.
- A second `put` for the same `thread_id` overwrites (latest-only), and `getTuple` returns the newer tuple.
- `putWrites` pending writes are retrievable in the next `getTuple` (needed for resume of an interrupted node).
- `Covers R16.` Simulate the cross-request boundary: persist via one saver instance, construct a fresh saver instance (same pool), `getTuple` returns the stored state — proving resume survives without in-memory graph state.
- `getTuple` for an unknown `thread_id` returns undefined; `deleteThread` removes the stored checkpoint.
- A checkpoint `put` and a concurrent transcript write to the same conversation-doc row both survive (each uses single-statement `jsonb_set` on its own key) — neither clobbers the other.

**Verification:** A graph compiled with this checkpointer can pause in one invocation and resume in a separate invocation reading only from Postgres; concurrent checkpoint/transcript writes do not clobber.

---

### U4. Model-boundary adapter (chat models + structured output + availability)

**Goal:** A single seam that owns provider selection, tool-schema conversion, structured-output safety, and the availability gate — and is the module tests mock.

**Requirements:** R6, R18, R20.

**Dependencies:** U1.

**Files:**
- `api/src/services/fleetgraph/model.ts` (create): exports the chat-model factory (`ChatOpenAI`/`ChatAnthropic` selected from the existing `FLEET_AI_PROVIDER` env convention), a structured-output helper, `isFleetGraphAvailable()`, and the tool-schema sanitizer.
- `api/src/services/fleetgraph/model.test.ts` (create).

**Approach:** Reuse `resolveProvider()`/`getClient()`/`isFleetAiAvailable()` semantics and the `process.env.FLEET_AI_PROVIDER` / `FLEET_AI_MODEL` / key convention from `fleet-ai.ts` (no central config module). For the chat tool-loop, build `ChatOpenAI`/`ChatAnthropic` with `.bindTools()`. For tool/output schemas, apply the documented zod-v3 discipline (see `docs/solutions/integration-issues/anthropic-sdk-zod-v3-v4-structured-output-mismatch.md`): one zod source of truth, convert to JSON Schema with `$refStrategy:'none'`, strip the unsupported keyword subset (`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`minLength`/`maxLength`/`pattern`/`multipleOf`/`format`/`$schema`) for Anthropic, and always `safeParse`. Wrap model calls to never throw — map SDK errors/truncation/refusal to a neutral result so a provider blip cannot orphan a paused write. `isFleetGraphAvailable()` returns false when `FLEET_AI_PROVIDER=none`.

**Patterns to follow:** `api/src/services/fleet-ai.ts` (provider resolution, never-throws error union, `toProviderJsonSchema`/`stripUnsupported`); the zod-v3/v4 learning doc.

**Test scenarios:**
- `Covers R18.` With `FLEET_AI_PROVIDER=none`, `isFleetGraphAvailable()` is false and no model is constructed.
- Provider selection returns the correct chat model class for `openai` vs `anthropic` and respects `FLEET_AI_MODEL` override / defaults.
- Tool-schema sanitizer strips the unsupported keywords and `$schema` for the Anthropic path; a schema carrying bounds/pattern still produces a valid Anthropic grammar.
- A model call that throws (or returns malformed JSON) is mapped to the neutral error result, never propagated as an exception.
- `Covers R20.` The module exposes a seam such that a scripted fake chat model can be injected in tests (the LangGraph equivalent of mocking `fleet-ai.js`).

**Verification:** Graph nodes obtain models only through this module; CI can run with no key by mocking it.

---

### U5. Read tools + parallel fetch layer

**Goal:** Give the agent visibility-correct read access to a Project/Week and its associated entities, fetched in parallel without redundant queries.

**Requirements:** R3, R7.

**Dependencies:** U1.

**Files:**
- `api/src/services/fleetgraph/tools/read.ts` (create): read tools (focal document + body, associations, people/roles, recent standups/comments/status changes), each threading `FleetContext`.
- `api/src/services/fleetgraph/nodes/fetch.ts` (create): parallel fetch node(s) using the tools.
- `api/src/services/fleetgraph/tools/read.test.ts` (create).

**Approach:** Adopt the `FleetContext` ({ workspaceId, userId, isAdmin }) shape from `fleet-service.ts` and apply the same `VISIBILITY_FILTER_SQL` / `getVisibilityContext` so reads never exceed what the user can see (the issues query stays `visibility='workspace'`-correct per the existing Fleet precedent). Reuse the existing hierarchy/context-assembly logic in `api/src/routes/claude.ts` for the program→project→week→issues/standups traversal rather than re-querying entity-by-entity (satisfies R3). Escape untrusted document content (`<`→`&lt;`, `>`→`&gt;`) before it enters any prompt, and treat content-derived values as untrusted. Fan out fetch tools as parallel graph edges; merge via a state reducer.

**Patterns to follow:** `gatherSignals` in `api/src/services/fleet-service.ts`; `getVisibilityContext`/`VISIBILITY_FILTER_SQL` in `api/src/middleware/visibility.ts`; context assembly in `api/src/routes/claude.ts` (but NOT its read-only/CSRF-bypass posture).

**Test scenarios:**
- `Covers R7.` Each read tool returns the focal entity and its associations for a visible project/week.
- `Covers R3.` A fetch run for a project does not issue per-entity duplicate queries (assert the consolidated traversal is used).
- A read tool invoked with a `FleetContext` for a user who cannot see the entity returns empty/denied — not another user's private data (mirror the existing cross-workspace "no leak" tests).
- Untrusted angle-bracket content in a fetched document body is escaped before prompt interpolation.

**Verification:** The agent's reads are visibility-equivalent to the requesting user; parallel fetch merges cleanly into graph state.

---

### U6. Write tools + audit (user-permission execution)

**Goal:** Let the agent perform real mutations through the same authorization the user faces, with an audit trail marking agent initiation.

**Requirements:** R8, R9, R12.

**Dependencies:** U1, U5.

**Files:**
- `api/src/services/fleetgraph/tools/write.ts` (create): confirmable write tools — create issue, patch issue (status/owner/priority/assignment/edit), post comment.
- `api/src/services/issues-service.ts` and `api/src/services/comments-service.ts` (create — extraction confirmed in scope): pull the core mutation bodies out of the route handlers into `FleetContext`-taking functions callable by both the routes and the tools.
- `api/src/routes/issues.ts`, `api/src/routes/comments.ts` (modify): call the extracted service functions (no behavior change).
- `api/src/services/fleetgraph/tools/write.test.ts` (create).

**Approach:** There is no privileged write path — tools call the same load-then-mutate logic the HTTP routes use, scoped by the user's `FleetContext` and `getVisibilityContext`, so the agent cannot write what the user cannot. Reuse `pool.connect()`/`BEGIN`/`COMMIT`/`ROLLBACK` for multi-statement writes (issue create + associations), `getTimestampUpdates`/`logDocumentChange(..., 'fleetgraph')` for field provenance, and `logAuditEvent({ action, resourceType, resourceId, details:{ agent_initiated:true, approved_by:userId } })` for the audit trail. Tools return a structured proposal shape (what will change) so the action node can surface it for confirmation before execution. **Every write-tool argument is validated against a strict zod schema before execution** — IDs as `uuid`, status/priority as enums, free-text fields length-bounded — so LLM-generated args derived from untrusted document content cannot smuggle a malformed or out-of-scope mutation past the type boundary (this is the mechanized form of "treat content-derived tool args as untrusted").

**Patterns to follow:** `POST /api/issues` and `PATCH /api/issues/:id` in `api/src/routes/issues.ts`; `POST /api/documents/:id/comments` in `api/src/routes/comments.ts`; `logAuditEvent` in `api/src/services/audit.ts`; `logDocumentChange`/`getTimestampUpdates` in `api/src/utils/document-crud.ts`.

**Execution note:** Characterization-first on the extracted service functions — capture the routes' existing behavior with tests before extracting, so the refactor is provably behavior-preserving.

**Test scenarios:**
- `Covers R8.` Each write tool, given an approved proposal, performs the mutation (issue created; issue status/owner patched; comment posted) and returns the result.
- `Covers R9, AE2.` A write tool invoked for a user lacking permission on the target is rejected by the same authorization that rejects the user directly — no agent bypass.
- `Covers R12.` Every successful agent write records an audit entry with `agent_initiated:true` and the approving user; field changes record `automated_by:'fleetgraph'` in document history.
- The extracted service functions produce identical results when called from the route vs. the tool (refactor parity).
- A write tool failure (DB error) does not leave partial state (transaction rolls back).

**Verification:** Existing issue/comment route tests still pass post-extraction; agent writes are audited and permission-bounded.

---

### U7. Graph assembly (nodes, edges, interrupt/resume, compile)

**Goal:** Assemble the shared graph: scope → parallel fetch → reasoning → policy → action, with the confirmed-write interrupt and the custom checkpointer.

**Requirements:** R1, R2, R4, R5, R6.

**Dependencies:** U3, U4, U5, U6.

**Files:**
- `api/src/services/fleetgraph/state.ts` (create): `Annotation`-based state with reducers for parallel fan-in.
- `api/src/services/fleetgraph/nodes/scope.ts`, `nodes/reason.ts`, `nodes/policy.ts`, `nodes/action.ts` (create).
- `api/src/services/fleetgraph/graph.ts` (create): `StateGraph` wiring + `compile({ checkpointer })`.
- `api/src/services/fleetgraph/index.ts` (create): entry points `runPlanReview()`, `runChatTurn()`, `resumeChatTurn()`.
- `api/src/services/fleetgraph/graph.test.ts` (create).

**Approach:** Use the `Annotation` API for state (zero zod coupling there); reserve zod for tool schemas. Fan out from scope to the fetch tools as concurrent edges, merging via a `concat` reducer. The reasoning node feeds `fleet-checks.ts` deterministic signals as cheap inputs and calls the model via U4. The policy node classifies outputs: low-risk → output; any write → action node. The action node calls `interrupt(proposal)` to pause and surface the proposed write; on resume via `Command({ resume })` the node re-runs from the top, so **the actual mutation executes after `interrupt()`** and any pre-interrupt work is idempotent (the critical HITL footgun from research).

**Proposal/execution parity invariant (security):** `interrupt(proposal)` serializes the *complete, fully-resolved* write arguments as the proposal payload; the action node on resume executes **only those confirmed args**, never re-derived from LLM/graph state. The args displayed to the user and the args executed are the same object (or verified equal via a content hash at resume) — this closes the confused-deputy gap where injected content could make the executed write differ from what was approved.

**Resume re-run scope:** because resume re-runs the interrupted node from the top, identify which side effects sit before `interrupt()` and ensure none double-fire on confirmation — specifically the rate-limit token (U9), the provider/model call, and conversation-document creation must each either run before the graph entry (outside the re-run path) or be guarded idempotent. Do **not** scope idempotency to "the mutation" alone.

**Compile + pool:** compile once with the U3 checkpointer, but ensure the checkpointer receives the initialized `pg` pool — guarantee `db/client.js` is imported/initialized before `fleetgraph/index.ts`, or inject the pool lazily, so a module-load compile doesn't capture an unconnected pool (fails only at first resume otherwise).

**Patterns to follow:** LangGraph `StateGraph`/`Annotation`/`interrupt`/`Command` (research report); `fleet-checks.ts` for deterministic signals.

**Execution note:** Test the interrupt→resume loop deterministically with a scripted fake chat model and the checkpointer.

**Test scenarios:**
- `Covers R1, R2.` A proactive input runs scope→fetch→reason→policy→output and returns a structured result (no chat).
- `Covers R5.` A chat input where the model proposes a write pauses at the action node; the interrupt payload equals the proposed mutation; resuming with `{approved:true}` executes the write; resuming with `{approved:false}` abandons it and continues.
- On resume, pre-interrupt work does not double-execute and the mutation fires exactly once (idempotency guard).
- `Covers R4.` The policy node routes a draft/answer to output (no interrupt) and a mutation to the action node.
- `Covers R6.` Deterministic `fleet-checks` signals are present in the reasoning node's inputs.
- A model error inside reasoning degrades to a neutral output without crashing the graph or orphaning a checkpoint.
- Parity: the args executed on resume equal the args in the surfaced proposal; a scripted model that "changes its mind" between pause and resume cannot alter the executed write.
- Resume does not double-consume: a rate-limit token / model call / conversation-doc creation that ran on the initial turn does not re-fire on `Command` resume.
- `Covers F1/F3 outcome.` Given a stalled project (an issue with no movement + a stale plan), the graph's reasoning output names *why* it's stuck and a recommended next action — not just a list of fetched entities (the differentiating goal, exercised with a scripted model asserting the prompt carries the diagnosis framing).

**Verification:** The same compiled graph serves both entry inputs; the confirmed-write loop survives a simulated cross-request boundary; executed writes match approved proposals.

---

### U8. Migrate proactive plan-review onto the graph

**Goal:** Make the graph the producer of the plan-review result while preserving the cached, hash-keyed `properties.fleet` contract and removing the deterministic user-facing fallback.

**Requirements:** R13, R14, R18.

**Dependencies:** U7. **Sequenced last — land with or after U10** (despite the lower U-ID, which is preserved). This unit removes the shipped no-key guarantee; sequencing it after the chat surface ensures the regression and the new agentic value land together rather than leaving keyless installs strictly worse mid-rollout. Gate behind the per-environment provider check (Risk Analysis).

**Files:**
- `api/src/services/fleet-service.ts` (modify): keep `getReview`'s shell — `gatherSignals`, hashing, `jsonb_set` write on `properties.fleet`, rate-limit gating, and the `FleetReviewResponse` shape — but replace the interior `buildPlanReview`/`buildRetroRecommendation` compute with a call to `runPlanReview()` from the graph.
- `api/src/services/fleet-ai.ts` (modify): the single-shot `evaluateStructured` path is no longer the plan-review's execution path (it remains the structured-output utility the graph's proactive reasoning node calls via U4).
- `api/src/services/fleet-service.test.ts` (modify).
- `api/src/routes/fleet.test.ts` (modify): the former `FLEET_AI_PROVIDER=none` deterministic-fallback assertions become unavailability assertions.

**Approach:** The cleanest seam keeps the caching/rate-limit/visibility shell intact (minimal blast radius, preserves AE5) and swaps only the compute. Remove the `allowAi`/deterministic-fallback branches inside the builders (R18): when no provider is configured, the plan-review is unavailable rather than returning deterministic pieces. `fleet-checks.ts` survives as reasoning input (R6), not as user-facing output.

**Patterns to follow:** existing `getReview` orchestration in `api/src/services/fleet-service.ts`; the `FleetReviewResponse`/`FleetPlanReview` shapes in `shared/src/types/fleet.ts` and `api/src/openapi/schemas/fleet.ts`.

**Test scenarios:**
- `Covers R13.` The plan-review result is produced by the graph (assert `runPlanReview` is the compute path), not by a direct `evaluateStructured` call.
- `Covers R14, AE5.` The Project Details card and retro panel still receive the same `FleetReviewResponse` shape, served from the `properties.fleet` cache on a hash hit and recomputed via the graph on a miss; the `jsonb_set` write still excludes sibling keys and does not bump `updated_at`.
- `Covers R18, AE4.` With `FLEET_AI_PROVIDER=none`, the plan-review GET reports unavailable (no deterministic pieces).
- The cache-miss rate-limit gating (`checkFleetReviewRateLimit`) still applies; force-refresh still bypasses it.
- Cross-workspace request still 404s with no cached-analysis leak.

**Verification:** The shipped card/retro behavior is unchanged with a provider configured; deterministic fallback is gone.

---

### U9. On-demand chat endpoints (SSE turn, confirm/decline, conversation doc)

**Goal:** Expose the chat: a streaming turn endpoint, a confirm/decline endpoint that resumes the graph, conversation-document creation, a per-user cost guard, and OpenAPI registration.

**Requirements:** R5, R10, R11, R12, R15, R18, R19.

**Dependencies:** U7, U2.

**Files:**
- `api/src/services/fleetgraph/conversation.ts` (create): create/read the hidden `conversation` document, associate it to the entity via `relationship_type='discusses'`, append turns to the transcript.
- `api/src/routes/fleetgraph.ts` (create): `POST` chat-turn (SSE stream), `POST` confirm/decline (resume), `GET` conversation fetch; all under `authMiddleware` + `conditionalCsrf`; mounted in `api/src/app.ts`.
- `api/src/services/fleetgraph/rate-limit.ts` (create) OR extend `fleet-ai.ts`: `checkFleetChatRateLimit(userId)` mirroring the existing in-memory `takeToken` limiter.
- `api/src/openapi/schemas/fleetgraph.ts` (create) + `api/src/openapi/schemas/index.ts` (modify): register the new paths.
- `api/src/app.ts` (modify): mount the router; ensure `compression` is disabled on the SSE route.
- `api/src/routes/fleetgraph.test.ts` (create).

**Approach:** The chat-turn route seeds graph input from the route context ({ entityId, entityType, message }, plus prior transcript), runs the graph with a `thread_id` tied to the conversation document, and streams via SSE. Note `entityType:'week'` maps to `document_type='sprint'` (and weekly_plan/weekly_retro) when resolving the focal entity — there is no `week` document type.

**Confirmed-write authorization (P0):** the confirm/decline route resumes with `Command({ resume })` on the same `thread_id`, but **first loads the conversation document by `thread_id` and asserts `created_by === req.userId` AND `workspace_id === req.workspaceId`, returning 403 on mismatch.** Without this, any authenticated workspace member could resume another user's paused write. The conversation **GET** endpoint applies the same ownership check (owner or workspace admin only) — transcripts hold fetched issue/standup/people content.

**One in-flight turn per conversation:** reject (or queue) a second chat turn on a `thread_id` whose checkpoint has a pending proposal, so a concurrent turn can't overwrite the paused checkpoint (the U3 concurrency precondition).

**Transport:** the chat-turn route is `POST` streaming SSE; the client (U10) consumes it via `fetch` + `ReadableStream`, **not** `EventSource` (which is GET-only and cannot send the CSRF header). Reject `GET` on the chat-turn route (405). Disable compression on the SSE path concretely: set `Cache-Control: no-transform` + `Content-Type: text/event-stream` before first write, or add a `filter` to the global `compression()` config that returns false for `text/event-stream` — mounting the router after `app.use(compression())` does **not** exempt it. Wire `req.on('close')` to an `AbortController` via `config.signal`. When the graph pauses, end the stream and return the proposal + `thread_id`.

Conversation documents are created hidden (excluded per U2) and titled `"Untitled"` per convention. Apply `checkFleetChatRateLimit` → 429 (consumed once, before graph entry, so resume doesn't re-bill — see U7). **Rate-limit caveat:** the in-memory limiter resets on process restart and is per-instance; acceptable for single-instance EB today but document it as a residual cost-abuse risk (a Postgres-backed counter on the user's person doc is the durable upgrade). Register every path with OpenAPI.

**Patterns to follow:** the Fleet refresh route (429 + CSRF) in `api/src/routes/projects.ts`; SSE wiring from the research report; OpenAPI pattern in `api/src/openapi/schemas/fleet.ts` + `registry.ts`; the test harness (sessions/CSRF/cross-workspace) in `api/src/routes/fleet.test.ts`.

**Test scenarios:**
- `Covers R10, R11.` A chat-turn on a Project (and a Week) streams a response grounded in that entity; the SSE response sets event-stream headers and is not buffered behind compression.
- `Covers R5, R12.` A turn that proposes a write ends with a proposal + `thread_id`; the confirm endpoint with `{approved:true}` resumes and applies the audited write; `{approved:false}` abandons it.
- `Covers R15.` A chat session creates a `conversation` document associated via `'discusses'` to the entity; it is retrievable by the conversation GET but absent from document-list endpoints.
- `Covers R19.` Chat turns past the per-user limit return 429 with no model call.
- `Covers R18.` With `FLEET_AI_PROVIDER=none`, the chat endpoints report unavailable.
- `Covers R9 (P0).` A confirm request from a *different* authenticated user on someone else's `thread_id` returns 403 and performs no write; the conversation GET from a non-owner non-admin returns 403.
- A second chat turn on a `thread_id` with a pending proposal is rejected/queued (does not overwrite the paused checkpoint).
- A `GET` to the chat-turn route returns 405; the SSE response is not buffered behind global compression (asserts `no-transform`/filter took effect).
- Unauthenticated → 401; chat on a non-visible entity → 404 (no leak); mutating endpoints without CSRF token are rejected.
- OpenAPI document includes the new FleetGraph paths.

**Verification:** A user can hold a streamed, context-scoped chat on Project/Week, approve a write, and the conversation persists hidden.

---

### U10. Web chat UI on Project and Week pages

**Goal:** An in-page chat control on Project and Week pages, seeded with route context, rendering the stream and the confirm/decline prompt for proposed writes.

**Requirements:** R10, R11, R5.

**Dependencies:** U9.

**Files:**
- `web/src/components/fleetgraph/FleetGraphChat.tsx` (create): the chat drawer/panel.
- `web/src/components/fleetgraph/FleetGraphChatLauncher.tsx` (create): the in-page open control.
- `web/src/hooks/useFleetGraphChat.ts` (create): SSE consumption + confirm/decline mutations, seeded with `{ entityId, entityType }`.
- Project and Week page hosts (modify): mount the launcher on the Project and Week surfaces (e.g., via the existing content/properties layout slots used by the Fleet card).
- `web/src/components/fleetgraph/FleetGraphChat.test.tsx` (create).

**Approach:** Open from an in-page launcher (not a route-agnostic global chatbot, not in nav). Seed the session with the current page's entity context so the user doesn't restate it. Consume the SSE stream via `fetch`+`ReadableStream` (not `EventSource`) and render tokens incrementally. Specific design decisions (so they aren't invented inconsistently):

- **Placement:** the chat is a right-side **overlay drawer** launched from a button in the Properties sidebar — NOT a `contentBanner` (which can't host a streaming, scrollable transcript) and NOT a fifth panel (the 4-panel layout is a fixed contract). The drawer needs focus-trap, scroll-lock, and Escape-to-close.
- **Confirm/decline display:** a proposed write renders as a **structured card** — action verb + target entity (title/id) + each field being set/changed with labels — not raw tool-call JSON and not a bare prose sentence. The user must see exactly what will be written before approving.
- **Pending-proposal lifecycle:** if the user navigates away or the stream drops with a proposal pending, on return the drawer **re-fetches the conversation and re-surfaces the pending proposal** (it persists server-side via the checkpoint); the user can still confirm or decline it. A pending proposal is not silently abandoned.
- **History / states:** on open, fetch and render prior turns from the conversation GET (agent vs. user messages visually distinct); define explicit empty (first-open), loading (turn in-flight: input disabled + indicator), streaming (tokens appending), and error/aborted (retryable) states.
- **Accessibility:** the transcript is an `aria-live="polite"` region so streamed tokens are announced; when the confirm/decline card appears mid-stream, move focus to it; launcher and drawer are keyboard-operable.
- **Unavailable state:** when no provider is configured, **hide** the launcher (don't render a dead disabled control) — consistent with the feature being absent, not broken.

**Patterns to follow:** the existing Fleet UI (`web/src/components/fleet/FleetReviewContainer.tsx`, `FleetAnalysisCard.tsx`, `web/src/hooks/useFleetReview.ts`) for self-fetching glue, query keys, and placement; TanStack Query conventions.

**Test scenarios:**
- `Covers R10.` The launcher appears on Project and Week pages and opens a session seeded with the page's entity context.
- `Covers R11.` Streamed tokens render incrementally as they arrive.
- `Covers R5.` A proposed write renders as a structured card (action + target + fields), not raw JSON; confirming sends the approval and resumes; declining closes the proposal without a write.
- Re-opening the drawer after navigating away with a proposal pending re-surfaces that proposal (fetched from the conversation) and it remains confirmable.
- On open, prior conversation turns render with agent/user visually distinguished; empty, loading (input disabled), streaming, and error states each render distinctly.
- The transcript is an `aria-live` region; focus moves to the confirm/decline card when it appears.
- The launcher is hidden (not a dead disabled control) when no provider is configured.
- Error/aborted stream surfaces a non-fatal message and the session can be retried.

**Verification:** End-to-end, a user opens chat on a Project/Week, gets a streamed answer, and can approve an agent-proposed write from the UI.

---

## System-Wide Impact

- **Dependencies:** repo-wide `zod` minor bump (U1) — widest blast radius; guarded by re-running existing AI tests first. Second `@anthropic-ai/sdk` copy installed transitively (benign).
- **Database:** two new ENUM values (U2); no new tables. Checkpoint state lives in `properties` JSONB on conversation documents (U3).
- **Auth/permissions:** write tools reuse existing visibility/authorization; no new privileged path (U6). New mutating endpoints join the `conditionalCsrf` set (U9).
- **Philosophy reviewer** auto-triggers on the migration, new components, and route additions — expect it to scrutinize the new `document_type`, the checkpointer-in-JSONB choice, and the chat UI; all are deliberate and documented here.
- **Shipped Fleet behavior** is preserved for provider-configured users (U8, AE5) but **regresses** to unavailable when no provider is set (U8, R18). The trade-off was accepted upstream, but the *rollout* consequence must be handled: any environment running the documented `none` default loses a working feature on deploy. Gate the deploy on a configured provider per environment, ship a user-facing "requires a provider" state (not a silently-vanished feature), and enumerate which environments run keyless before shipping U8.

---

## Key Technical Decisions

- **Graph-first migration via the `getReview` shell (U8):** keep caching/rate-limit/visibility, swap only compute. Rationale: preserves the card/retro contract (AE5) with minimal blast radius.
- **Custom JSONB checkpointer over PostgresSaver (U3):** honors Ship's hard "no new tables" rule and survives philosophy review; latest-tuple-only keeps the custom-saver surface small. Rationale: chosen by the user over the lower-effort library tables.
- **Two-tier provider strategy (U4, U8):** keep `fleet-ai.ts` for the proactive structured insight (retains the tested zod-v3/v4 Anthropic workaround); use LangChain chat models for the chat tool-loop (clean tool-call/interrupt plumbing).
- **Graph requires a provider (U4, U8, U9):** no deterministic user-facing fallback; features unavailable when `FLEET_AI_PROVIDER=none`. Rationale: a single unified agentic graph, accepted regression of the shipped no-key guarantee.
- **SSE for chat streaming (U9):** inherits auth/CSRF/rate-limit from the normal route stack; avoids coupling to the Yjs binary WS. Rationale below in Risk.
- **New `'discusses'` relationship type (U2):** avoids polluting `'parent'`-based hierarchy traversals with hidden conversation links.
- **Mutation-after-`interrupt()` idempotency rule (U7):** resume re-runs the node from the top, so the write must follow the interrupt and pre-interrupt work must be idempotent.
- **U8 sequenced last (resolved in review):** the proactive migration + no-key regression lands with/after U10 so the regression and the new chat value ship together — keyless installs are not left strictly worse mid-rollout.
- **U6 extraction confirmed in scope (resolved in review):** issue/comment mutation cores are extracted into `FleetContext` service functions shared by routes and tools (characterization-tested), rather than duplicating SQL in the tools — single source of truth, accepted refactor risk on shipped routes.
- **Reserve `insight` enum value now (resolved in review):** migration 045 adds `insight` alongside `conversation` though it has no consumer this iteration, to avoid a second `ALTER TYPE` migration when the deferred sweep builds insights-as-documents.

---

## Risk Analysis & Mitigation

- **SSE through CloudFront / compression buffering (R11):** the new streaming path needs its own CloudFront `ordered_cache_behavior` (`headers=["*"]`, `compress=false`, `ttl=0`), and the global `compression()` middleware (mounted before all routers) will buffer the stream unless bypassed. *Mitigation:* U9 sets `Cache-Control: no-transform` + `text/event-stream` (or a `compression` `filter` excluding event-stream) — naming the mechanism, since "disable on the route" has no route-local toggle; **the CloudFront `ordered_cache_behavior` change is owned by U9** (add the Terraform edit to its file list / deploy step, not an unowned checklist line); verify prod streaming post-deploy; fallback is the existing `/events` JSON WS push channel if prod streaming is blocked. Reference: `docs/solutions/websocket-cloudfront-configuration.md`.
- **Keyless installs silently lose plan-review on deploy (R18 regression):** the documented default is `FLEET_AI_PROVIDER=none`, which today yields a *working* deterministic plan-review; after U8 that becomes unavailable. *Mitigation:* add a deploy gate confirming a provider is configured in each target environment before shipping, and a user-facing "plan-review requires an AI provider — contact your admin" state rather than a feature that vanishes; identify which environments currently run keyless so the affected audience is known, not assumed empty. (See System-Wide Impact.)
- **Proposal/execution mismatch & concurrent-turn checkpoint overwrite:** addressed in U7 (parity invariant) and U3/U9 (single-statement disjoint-key writes + one-in-flight-turn) — listed here as the two highest-severity correctness risks of the HITL design.
- **`ALTER TYPE ... ADD VALUE` in a transaction (U2):** can fail under the per-migration transaction wrapper. *Mitigation:* adjust the migration runner to handle these statements; verify on a fresh DB.
- **HITL double-execution (U7):** resume re-runs the interrupted node. *Mitigation:* mutation strictly after `interrupt()`; pre-interrupt work idempotent; explicit test asserting the write fires exactly once on resume.
- **Prompt injection via fetched content (U5):** chat ingests far more untrusted document text than the single-shot path. *Mitigation:* entity-escape delimited content; treat content-derived tool args as untrusted before they reach a write tool; writes always require explicit user confirmation.
- **zod bump regressions (U1):** *Mitigation:* isolated commit, re-run `fleet-ai.test.ts` before building on it.

---

## Deferred to Implementation

- Exact tool inventory signatures and the precise structured proposal shape returned by write tools (settle against real LangChain message types during U6/U7).
- Whether proactive and chat modes share node implementations wholesale or branch at the policy/output nodes (resolve while wiring U7 — proactive emits an insight, chat streams a turn).
- The serializer details for the custom checkpointer's JSONB blob (U3) against the installed `@langchain/langgraph-checkpoint` version.
- Final SSE event framing and reconnection behavior (U9/U10).
- Whether `checkFleetChatRateLimit` lives in `fleet-ai.ts` or a sibling module (U9).

---

## Outstanding Questions

### Resolve Before Planning
- (none — all resolved. See Key Decisions for the three resolved during document review.)

### Deferred to Planning → now resolved
- Streaming transport → **SSE** (Key Decisions).
- Checkpoint mechanism → **custom JSONB checkpointer on the conversation document** (U3).
- Provider strategy → **two-tier** (U4).
- Conversation↔entity association → **new `'discusses'` relationship type** (U2).

### Deferred to Implementation
- See "Deferred to Implementation" above.
