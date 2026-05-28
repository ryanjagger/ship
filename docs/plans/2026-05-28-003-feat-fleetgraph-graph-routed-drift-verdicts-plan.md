---
title: "feat: Graph-routed Fleet drift verdicts (sweep through the LangGraph agent)"
type: feat
status: active
date: 2026-05-28
origin: (none — solo plan; builds on docs/plans/2026-05-28-002-feat-fleetgraph-llm-verdicts-plan.md)
---

# feat: Graph-routed Fleet drift verdicts (sweep through the LangGraph agent)

## Summary

Route drift verdict reasoning through the existing FleetGraph compiled graph (`scope → fetch → reason → policy → output`) instead of the direct `evaluateStructured` call shipped in the LLM verdicts PR. Adds a new `runDriftReasoning` entry point in `api/src/services/fleetgraph/index.ts` (sibling of `runPlanReview` / `runDedupReview` / `runChatTurn`), extends `FleetMode` with `'drift'`, and adds a drift-specific branch to the reason node that returns `{decision, reasoning}` against a focused Zod schema.

Going through the graph means drift now receives the full project context the `fetch` node already assembles for plan-review: focal project + plan text + ancestor program/project chain + workspace issues + workspace people + recent activity (standups, comments, status changes). The sweep swaps its `generateDriftVerdict` call for `runDriftReasoning`; the focused `verdictGenerator.ts` evaluator (U3 of the LLM verdicts PR) is **deleted** — graph-routed becomes the only LLM path. On any graph-execution failure the sweep falls back directly to the deterministic verdict (one less indirection than the LLM verdicts PR's design).

The per-workspace toggle (`settings.fleetgraph.llm_verdicts_enabled`) is unchanged. `VerdictOutput`, `evidence.verdict_source`, and `evidence.sweep_run_id` contracts are unchanged. Service-principal invocation uses a sentinel system UUID + `isAdmin: true` — the simplest pattern that the existing `VISIBILITY_FILTER_SQL` already supports natively.

---

## Problem Frame

The LLM verdicts PR (`docs/plans/2026-05-28-002-...`) shipped a focused `evaluateStructured` call for drift verdicts — system prompt + signal list + Zod-validated `{decision, reasoning}`. That works, but the model judges from signal labels alone (`"idle 9 days"`, `"plan stale 24d"`). It has no view of the actual plan text, recent issue movement, or who owns the work — exactly the context the graph's `fetch` node assembles for plan reviews and chat. The verdict's reasoning is consequently generic.

`docs/fleetgraph/presearch.md:48` states the intent: *"event-driven on relevant mutations ... plus a low-frequency scheduled sweep ... Both fire the same compiled graph; only the trigger differs."* This plan delivers that: the sweep is now a graph trigger like chat / plan-review / dedup, producing trace-tree-shaped LangSmith runs and richer verdict reasoning grounded in real project state.

---

## Requirements

- R1. New `runDriftReasoning(args, ctx)` entry point in `api/src/services/fleetgraph/index.ts` drives the compiled graph end-to-end and returns a discriminated result `{ available: true; verdict: InsightVerdict } | { available: false }`. Never throws — graph errors degrade to `{available:false}` and the caller applies the deterministic fallback.
- R2. `FleetMode` extends to include `'drift'`. `FleetGraphState` gains a `driftSignals: DriftSignal[]` channel (seeded by the entry point) and a `traceMetadata?: Record<string,string>` channel (forwarded into the drift branch's `evaluateStructured` call for LangSmith filterability).
- R3. The `reason` node gets a new `reasonDrift` branch dispatched when `state.mode === 'drift'`. Schema validates `{decision: 'SURFACE_ACT'|'SURFACE_FYI'|'SUPPRESS', reasoning: string}` (same shape the focused evaluator used). On `isFleetAiError` → `neutralDegrade()` (existing helper). Otherwise sets `state.analysis.driftReview = {decision, reasoning}, aiAvailable: true`.
- R4. The `fetch` node behavior is **unchanged** for drift. Drift reuses the existing fetch (project focal + plan + ancestors + issues + people + recent activity) without modification. Sufficient for v1; if a future iteration needs drift-specific context (e.g., a longer activity window), it adds a fetch-time branch then — not now.
- R5. Sweep's `buildVerdictForProject` calls `runDriftReasoning` instead of `generateDriftVerdict`. The `VerdictOutput` shape returned to the sweep loop is unchanged (`{verdict, degraded, source}`). When `runDriftReasoning` returns `{available:false}`, sweep sets `degraded: true` and uses the deterministic verdict; otherwise the LLM verdict.
- R6. `api/src/services/fleetgraph/verdictGenerator.ts` and its test file are **deleted**. The pinned invariants (prompt shape, metadata pass-through, schema validation) migrate into the new drift-mode branch's coverage via `graph.test.ts` (mirroring how the existing plan_review / dedup branches are covered end-to-end through the graph).
- R7. Service-principal invocation uses `ctx = { workspaceId, userId: SYSTEM_USER_ID, isAdmin: true }` where `SYSTEM_USER_ID` is a stable sentinel UUID (constant exported from the sweep module). `VISIBILITY_FILTER_SQL`'s existing `isAdmin === true` short-circuit (returns `'TRUE'`) gives drift workspace-wide read access without bespoke service-principal code in any node or tool.
- R8. Single 60s wall-clock timeout around the entire `graph.invoke(...)` call. Any timeout, throw, or terminal state without a verdict triggers fallback to deterministic.
- R9. Trace metadata (`workspace_id`, `sweep_run_id`) is threaded into the drift reason branch's `evaluateStructured` call via the existing `metadata?: Record<string,string>` field on `FleetEvalRequest`. Also passed into `RunnableConfig.metadata` for LangChain's auto-trace at the graph-root level.
- R10. Settings page copy on `/settings/fleet` updates the LLM toggle description to: "When enabled, drift insights include reasoning from an AI model that reviews the project's plan and recent activity. Adds API costs per detected drift." Reflects the richer prompt.

---

## Scope Boundaries

- Drift kind only (`'project_drift'`). Other kinds (if any future) need their own graph mode.
- No changes to chat / plan_review / dedup entry points or their reason branches.
- No fetch-node changes — drift reuses the existing fetch shape.
- No batching across projects; one graph run per drifting project per tick (matches LLM verdicts PR).
- No retry. One graph run; on any failure, fall back to deterministic + `degraded:true`.
- No per-node timeouts. Single wall-clock around the whole `graph.invoke`.
- No new env flag. The per-workspace `settings.fleetgraph.llm_verdicts_enabled` toggle decides whether to invoke the graph at all.
- No new audit-log entries — drift's path doesn't touch `writeTools`.
- No streaming for drift — `runDriftReasoning` is a request/response shape like `runPlanReview`, not like `streamChatTurn`.

### Deferred to Follow-Up Work

- A fetch-time `'drift'` branch that pulls a longer or differently-shaped activity window. Defer until verdict quality observation suggests the current fetch is insufficient.
- Per-node timeouts (e.g., 10s on fetch, 30s on reason). Defer; the single wall-clock is the smaller change.
- Surfacing the verdict's reasoning text in `InsightDetail` (web). The substrate stores it; the UI doesn't render it yet. Separate UX task.
- A LangSmith dashboard query saved per workspace for "all drift runs from sweep_run_id X" — operational nice-to-have, not blocking.
- Multi-kind detection (ownerless issue, stalled issue, etc.) each routed through its own graph mode.

---

## Context & Research

### Relevant Code and Patterns

**Graph entry-point template**
- `api/src/services/fleetgraph/index.ts` — `runPlanReview` (~91-176) is the canonical mirror for `runDriftReasoning`: transient `crypto.randomUUID()` thread_id, `configurable: { thread_id, checkpoint_ns: '' }`, `metadata: { environment: LANGSMITH_ENV }`, never throws, returns a discriminated `available: boolean` result. The implementation also confirms the graph itself never throws — degradation is internal.
- `runDedupReview` (~195) is a second reference for a non-chat structured-output entry point.

**Graph state**
- `api/src/services/fleetgraph/state.ts` — `FleetMode` at ~44 (the union to extend), `FleetGraphState = Annotation.Root({...})` at ~72-108 (where new channels land). Existing dedup-only channels (`draftTitle`, `candidates` ~88-89) show the additive shape for `driftSignals`.
- `FleetAnalysis` interface at ~47-62 — has `planReview?: unknown` and `dedupReview?: unknown` slots. Add `driftReview?: unknown` here; entry point downcasts at the boundary.

**Reason node + dispatch**
- `api/src/services/fleetgraph/nodes/reason.ts` — `makeReasonNode(deps)` at ~244-276 is the dispatcher (switches on `state.mode`). `reasonProactive` (~284-305) is the closest template for `reasonDrift`: builds prompt, calls `evaluateStructured` with schema + schemaName, discriminates `isFleetAiError`, calls `neutralDegrade` on error or sets `analysis: {text, planReview|dedupReview, aiAvailable: true}` on success.
- The `evaluateStructured` import is from `../../fleet-ai.js`. The drift branch uses the same — already auto-traced via the langsmith SDK wrappers in `fleet-ai.ts:25-26`.

**Visibility short-circuit**
- `api/src/middleware/visibility.ts:65-80` — `VISIBILITY_FILTER_SQL(alias, userIdParam, isAdminParamOrValue)`. When `isAdminParamOrValue === true` (the literal boolean), returns `'TRUE'` and skips both the `visibility='workspace'` check and the `created_by = userId` clause. This is what service-principal drift uses.
- `api/src/services/fleetgraph/tools/read.ts:162-213` — `fetchFocal` uses `VISIBILITY_FILTER_SQL` with `ctx.isAdmin`. With `isAdmin: true`, drift sees every non-archived/non-deleted project regardless of `created_by`.

**FleetContext**
- `api/src/services/fleet-service.ts:32-36` — canonical definition: `{ workspaceId: string; userId: string; isAdmin: boolean }`. Drift seeds this from the sweep with `userId = SYSTEM_USER_ID` (a constant sentinel UUID, exported from the sweep module) and `isAdmin: true`.

**Sweep call-site swap**
- `api/src/services/fleetgraph/sweep.ts:422-475` — `buildVerdictForProject` is where `generateDriftVerdict(...)` is currently invoked. Swap call to `runDriftReasoning(...)`; on `{available: false}` use the deterministic fallback + set `degraded: true`. The `VerdictOutput` shape returned to the sweep loop is unchanged.

**Tests**
- `api/src/services/fleetgraph/graph.test.ts` — real-Postgres integration test pattern: mock `evaluateStructured` at `vi.mock('../fleet-ai.js', ...)`, real graph + checkpointer + workspace fixtures. This is the template for `runDriftReasoning` end-to-end tests. Existing tests for `runPlanReview` (R1/R2 / model error degrades, lines ~153-208) are direct analogs.
- `api/src/services/fleetgraph/sweep.test.ts` + `sweep.concurrency.test.ts` — mocks need to swap `generateDriftVerdict` mock for `runDriftReasoning` mock. The boundary stays at `./<verdictGenerator|index>.js`, no need to mock anything deeper.
- `verdictGenerator.test.ts` invariants to preserve (migrated into the new drift-mode coverage in `graph.test.ts`): schema name pinned, `maxTokens` set, `metadata.workspace_id` + `metadata.sweep_run_id` present, all three decisions pass through, both `FleetAiError` variants → degraded.

### Institutional Learnings

- `docs/solutions/tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — proactive non-graph paths still auto-trace via the SDK wrappers. Now that drift becomes a graph path, the graph root run also auto-traces with nested per-node spans. Per-call SDK-level metadata (`workspace_id`, `sweep_run_id`) is still threaded into `evaluateStructured` for filterability under the graph root.
- `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md` — write linkage in same tx as parent, verify via read path. Drift never writes (verdict → substrate is U4's existing `createOrRefreshInsight` call, unchanged); no new linkage surface introduced.

### External References

- None. LangGraph patterns are well-established locally (4 existing entry points). `evaluateStructured` + langsmith wrappers are documented and shipped.

---

## Key Technical Decisions

- **Extend `FleetMode` with `'drift'`** instead of introducing a separate `triggerKind` field. The graph already discriminates on `mode`; adding a fourth value is one-line additive. Avoids a parallel discriminator the nodes would have to inspect alongside `mode`.

- **Service principal via sentinel `userId` + `isAdmin: true`**, not via a discriminated-union `actor` on `FleetContext`. Rationale: `VISIBILITY_FILTER_SQL`'s existing `isAdmin === true` short-circuit gives drift exactly the "see all workspace docs" semantics it needs, with zero new branching in any node or tool. A discriminated union would force every consumer of `ctx.userId` to handle the service case; with the sentinel, the four existing call sites that read `ctx.userId` (`fetchFocal` SQL bind, `writeTools` audit log, `buildChatSystemPrompt` for chat-only "assign-to-me") either don't fire on drift's path or accept a UUID without inspecting its identity. The sentinel UUID is a constant exported from sweep (`SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'`); if any code ever wants to detect "the system did this" it can compare against the constant.

- **`runDriftReasoning` returns a discriminated result, not a verdict-or-fallback shape.** Result is `{available: true; verdict: InsightVerdict} | {available: false}`. The caller (sweep) owns the deterministic fallback — same contract `runPlanReview` uses (`{available: boolean; planReview, diagnosis, recommendedNextAction}`). Keeps the entry point's responsibility narrow: drive the graph, lift the verdict, signal availability.

- **`verdictGenerator.ts` is deleted, not retained as a code-path fallback.** Confirmed per user direction. Graph-routed becomes the only LLM path. Failure semantics simplify: graph runs OR sweep falls back to deterministic. No three-tier (graph → focused → deterministic) ladder. The invariants the focused evaluator's tests pinned migrate into the drift-mode graph tests.

- **Fetch node unchanged for drift.** Drift reuses plan_review's existing context (focal project + plan text + ancestors + workspace issues + people + recentActivity). Adding a drift-specific fetch branch is deferred until empirical verdict quality demands it. The fetch already returns enough signal — the only reason to graph-route is to use this context, and v1 just uses it as-is.

- **Single 60s wall-clock timeout around `graph.invoke`.** Implemented via `Promise.race` between the graph run and a timeout promise. On timeout: return `{available: false}`; sweep applies the deterministic fallback + degraded flag. Per-node timeouts deferred — drift is hourly cron, not latency-sensitive.

- **Trace metadata threading.** `runDriftReasoning` writes `traceMetadata` into the initial graph state. The `reasonDrift` branch reads it from state and passes it to `evaluateStructured` via the existing `metadata?: Record<string,string>` field. Also passed into `RunnableConfig.metadata` so the LangChain auto-trace root carries the same keys. Net: every span in the trace tree is filterable by `workspace_id` + `sweep_run_id`.

- **Drift verdict schema lives in the new branch, not shared with plan_review.** Plan-review's schema returns `{criteria, ...}` against the canonical `RUBRIC` — totally different from drift's `{decision, reasoning}`. Sharing would force one Zod schema to do two unrelated jobs. The drift schema is a small named export in `reason.ts` (or a small adjacent file) for test reuse.

- **No changes to `scope`, `policy`, `action`, or `output` nodes.** Drift inherits the existing routing: scope validates ctx + entityId (drift seeds both); policy routes to `output` when no proposal (drift never produces one); output is a no-op for drift since `state.analysis.text` isn't set (drift surfaces its verdict via `state.analysis.driftReview`, lifted at the entry point).

- **`SYSTEM_USER_ID` constant in `sweep.ts`, not a new module.** It's only used at one call site (constructing the `ctx` for `runDriftReasoning`). A new module for one constant is overkill. Document the constant with a "do not change this value once shipped" comment.

---

## Open Questions

### Resolved During Planning

- **Service principal pattern** → sentinel UUID + `isAdmin: true` (not discriminated union).
- **Mode discriminator** → reuse `FleetMode`, add `'drift'`.
- **Fetch node changes** → none in v1; reuse existing fetch.
- **Reason branching** → new drift branch, drift-specific schema (not shared with plan_review).
- **Timeout strategy** → single 60s wall-clock.
- **Trace metadata** → state-channel-passed; thread into both `RunnableConfig.metadata` and per-call SDK metadata.
- **`verdictGenerator.ts` fate** → deleted.
- **Settings UI change** → caption-only update on `/settings/fleet`.

### Deferred to Implementation

- **Exact drift prompt wording** — the system prompt for `reasonDrift`. The plan locks the shape (signals + project context + ask for `{decision, reasoning}`) but not the exact words. Settle while iterating against LangSmith traces on real data.
- **Whether `runDriftReasoning` exports a sweep-specific helper or is invoked directly** — likely direct invocation suffices; revisit if the sweep call site needs trimming.
- **Whether to pass `signals` as a separate state channel or fold them into a `driftContext` object** — minor naming/shape call best made when writing the state extension.
- **Exact handling of an empty `signals` array** — shouldn't happen in practice (the sweep only calls drift on `isDrifting === true` projects), but pick a defensive shape (degrade? throw?) during implementation. `verdictGenerator.ts`'s test for empty-signals had us calling the model anyway; preserve that behavior.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
sweep tick, per drifting project:
  ┌─ computeProjectDrift (unchanged)                     ← deterministic detector
  ├─ build deterministic verdict + inputHash             ← still the fallback
  ├─ if !llmVerdictsEnabled → deterministic (no graph)
  ├─ probe getInsightByIdentity → matching open hash? → deterministic (no graph)
  │
  └─ else: runDriftReasoning({entityId, signals, traceMetadata}, ctx) ─┐
                                                                       │
        ctx = {workspaceId, userId: SYSTEM_USER_ID, isAdmin: true}     │
        traceMetadata = {workspace_id, sweep_run_id}                   │
                                                                       ▼
                                            getCompiledGraph().invoke(state, runConfig)
                                                       │
                                                       │ wrapped in Promise.race(
                                                       │   graphRun,
                                                       │   timeoutAfter(60s) → throw
                                                       │ )
                                                       ▼
                                            scope (validates ctx + entityId)
                                                       ▼
                                            fetch (existing plan_review-shape pull:
                                                    focal + plan + ancestors +
                                                    issues + people + recentActivity)
                                                       ▼
                                            reason — mode='drift' branch:
                                              ├─ build prompt: signals + project context
                                              ├─ evaluateStructured<{decision, reasoning}>(
                                              │     { system, user, schema, schemaName,
                                              │       metadata: state.traceMetadata })
                                              ├─ isFleetAiError? → neutralDegrade()
                                              └─ else: state.analysis.driftReview =
                                                       { decision, reasoning }
                                                       ▼
                                            policy → output (no-op for drift)
                                                       ▼
                                            final state lifted by runDriftReasoning:
                                              if !aiAvailable OR no driftReview → {available: false}
                                              else → {available: true, verdict}
                                                       │
                                                       ▼
buildVerdictForProject:
  on {available: true}  → use LLM verdict; SUPPRESS-or-substrate as today.
  on {available: false} → deterministic verdict + degraded: true.

(verdictGenerator.ts and verdictGenerator.test.ts are deleted.)
```

---

## Implementation Units

### U1. Extend `FleetMode` + add drift state channels

**Goal:** Make the graph state model the drift trigger as a first-class mode, with channels for the signal list and trace metadata.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `api/src/services/fleetgraph/state.ts`
- Modify: shared/types if `DriftSignal` type isn't already importable from `@ship/shared` (verify; if it's only on the api side, leave it there)

**Approach:**
- Extend `FleetMode` union: `'plan_review' | 'chat' | 'dedup' | 'drift'`.
- Add channels to `FleetGraphState` Annotation:
  - `driftSignals: DriftSignal[]` (REPLACE, default `[]`). Seeded by `runDriftReasoning`.
  - `traceMetadata: Record<string,string> | null` (REPLACE, default `null`). Carries `workspace_id` + `sweep_run_id` for the drift branch to forward to `evaluateStructured`.
- Extend `FleetAnalysis` interface: add `driftReview?: unknown` alongside existing `planReview?: unknown` / `dedupReview?: unknown`. Keep `unknown` — the entry point downcasts at the boundary (consistent with how `planReview`/`dedupReview` are typed).
- No other state changes. `entityId` / `entityType` / `ctx` are reused as-is.

**Patterns to follow:** existing dedup-only channels (`draftTitle`, `candidates` at `state.ts:88-89`) for additive channel shape; existing `FleetAnalysis` slot pattern.

**Test scenarios:**
- Test expectation: none — pure type/state declarations exercised by U2/U3 tests. Verify `pnpm --filter @ship/api type-check` clean after the change.

**Verification:** `FleetGraphState` exports the new channels; `FleetMode` accepts `'drift'`; `FleetAnalysis` accepts `driftReview` without breaking existing callers.

---

### U2. Drift branch in the `reason` node + drift verdict schema

**Goal:** Add the LLM-call branch that produces `{decision, reasoning}` when `state.mode === 'drift'`, with schema validation, error degradation, and trace-metadata forwarding.

**Requirements:** R3, R9

**Dependencies:** U1

**Files:**
- Modify: `api/src/services/fleetgraph/nodes/reason.ts`

**Approach:**
- Add a small `reasonDrift(state, deps)` function near `reasonProactive` (~line 284). Mirror its shape exactly:
  - Build `system` + `user` strings. System describes the role (review a drift detection for a Fleet project); user serializes a context bundle including project title (from `state.fetched.focal`), plan text (from `state.fetched.focal.properties.plan`), recent activity (from `state.fetched.recentActivity`, limited to a sensible window — e.g. last N items), and the signals (from `state.driftSignals`).
  - Call `evaluateStructured<DriftVerdictAi>({ system, user, schema: driftVerdictSchema, schemaName: 'DriftVerdict', maxTokens: 200, metadata: state.traceMetadata ?? undefined })`.
  - On `isFleetAiError(ai)` → return `neutralDegrade(state)` (existing helper).
  - Else → set `state.analysis.driftReview = { decision: ai.decision, reasoning: ai.reasoning }`, `state.analysis.aiAvailable = true`, `state.analysis.text = ai.reasoning` (so the output node can no-op cleanly). Return.
- Define `driftVerdictSchema` as a module-level constant near the existing `planReviewAiSchema` (`~72-79`). Zod shape: `z.object({ decision: z.enum(['SURFACE_ACT','SURFACE_FYI','SUPPRESS']), reasoning: z.string().min(1).max(1000) })`.
- Update `makeReasonNode(deps)`'s dispatcher: add `if (state.mode === 'drift') return reasonDrift(state, deps);` at the obvious dispatch site (~252-274).
- Keep the existing focal-visibility guard (`reason.ts:260-265`): if `state.fetched.focal === null`, drift also early-degrades — service-principal with `isAdmin: true` makes this practically impossible (focal won't be null for a non-archived/deleted project), but the guard is correct.
- No changes to `reasonChat` / `reasonProactive` / `reasonDedup`.

**Patterns to follow:**
- `reasonProactive` at `reason.ts:284-305` — exact mirror for `evaluateStructured` call shape, isFleetAiError discrimination, `neutralDegrade` fallback.
- `planReviewAiSchema` at `~72-79` for module-level Zod schema placement.

**Test scenarios:** Coverage lives in U3's `graph.test.ts` integration tests (the existing `reasonProactive` and `reasonDedup` branches have no direct unit tests — they're exercised through `graph.test.ts`). The U3 unit will assert: schema-name pinned to `'DriftVerdict'`, `maxTokens` set, metadata pass-through, all three decisions flow through to `state.analysis.driftReview`, both `FleetAiError` variants trigger `neutralDegrade`.

**Verification:** A `state.mode === 'drift'` invocation reaching the reason node calls `evaluateStructured` once, returns `state.analysis.driftReview` populated on success, or `state.degraded = true` + `aiAvailable: false` on AI failure.

---

### U3. `runDriftReasoning` entry point + integration tests

**Goal:** Public function in `fleetgraph/index.ts` that drives the compiled graph end-to-end for a drift detection and returns the verdict (or signals unavailability). Integration tests cover the schema/metadata invariants that previously lived in `verdictGenerator.test.ts`.

**Requirements:** R1, R7, R8, R9

**Dependencies:** U1, U2

**Files:**
- Modify: `api/src/services/fleetgraph/index.ts`
- Modify: `api/src/services/fleetgraph/graph.test.ts` (add drift-mode integration tests)

**Approach:**
- Export interfaces:
  - `RunDriftReasoningArgs`: `{ entityId: string; signals: DriftSignal[]; ctx: FleetContext; traceMetadata?: Record<string,string> }`. `entityType` is hardcoded `'project'` in v1 (drift kind only).
  - `RunDriftReasoningResult`: `{ available: true; verdict: InsightVerdict } | { available: false }`.
- Export `async function runDriftReasoning(args, graph = getCompiledGraph()): Promise<RunDriftReasoningResult>`:
  - Build initial state: `{ mode: 'drift', entityId: args.entityId, entityType: 'project', ctx: args.ctx, driftSignals: args.signals, traceMetadata: args.traceMetadata ?? null }`.
  - Build `runConfig: RunnableConfig`: `configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' }`, `metadata: { environment: LANGSMITH_ENV, ...(args.traceMetadata ?? {}) }`.
  - Wrap `graph.invoke(initialState, runConfig)` in `Promise.race([..., timeoutAfter(60_000)])`. The timeout promise rejects with a tagged error so the catch can distinguish from other failures (logged differently but same return shape).
  - Try-catch the race:
    - On any throw → log + return `{available: false}`.
    - On completion → inspect `final.analysis?.driftReview`. If missing OR `final.degraded` OR `!final.analysis?.aiAvailable` → return `{available: false}`. Else → downcast and return `{available: true, verdict: {decision, reasoning}}`.
- Add a module-level constant `DRIFT_GRAPH_TIMEOUT_MS = 60_000` for testability.
- Never throws. Sweep is the only caller; the contract matches `runPlanReview`'s never-throws posture.

**Integration tests in `graph.test.ts`:**
- Test pattern: real-Postgres (`ship_test`), real graph compile, mock `evaluateStructured` via `vi.mock('../fleet-ai.js', ...)`. Mirror existing R1/R2 tests at `graph.test.ts:153-208`.
- Scenarios (each via `runDriftReasoning`):
  - Happy path with SURFACE_ACT — assert `{available:true, verdict.decision === 'SURFACE_ACT'}`; assert the mocked `evaluateStructured` received `schemaName: 'DriftVerdict'`, `maxTokens: 200`, and `metadata.workspace_id` + `metadata.sweep_run_id`.
  - Happy path with SURFACE_FYI — flows through.
  - Happy path with SUPPRESS — flows through (decision is propagated; sweep is what decides to skip the substrate).
  - Model returns `{error: 'ai_unavailable'}` → `{available: false}`.
  - Model returns `{error: 'ai_parse_error'}` → `{available: false}`.
  - Graph invoke throws → `{available: false}`.
  - Timeout (set `DRIFT_GRAPH_TIMEOUT_MS` to a low value via the module-level export OR control via a deps override; or use a long-running mocked `evaluateStructured`) → `{available: false}`.
  - Trace metadata pass-through: assert `RunnableConfig.metadata` contains the workspace_id + sweep_run_id (read via the LangChain trace mock or by inspecting the call to `graph.invoke`).
  - Cross-workspace isolation: service-principal `ctx.workspaceId = 'ws-1'` cannot return a verdict pointing at an entity in `'ws-2'` — assert via fetch-node behavior (focal returns null for cross-workspace entity → degrades).
  - Sentinel `userId` + `isAdmin: true` produces a fetched focal for a workspace-private project (would have been filtered out for a non-admin non-owner).

**Patterns to follow:**
- `runPlanReview` (`index.ts:91-176`) for entry-point shape, never-throws contract, `RunnableConfig` shape, result lifting from `final.analysis`.
- `graph.test.ts` (lines 1-145 setup, 153-208 R1/R2 tests) for end-to-end test structure.
- `verdictGenerator.test.ts` invariants — preserve them in the new test coverage even though that file is deleted.

**Test scenarios:** (covered above in Integration tests sub-section)

**Verification:** `runDriftReasoning` returns the verdict for a real drifting project end-to-end through the graph; degrades cleanly on every failure mode; trace metadata reaches both LangChain auto-trace and the per-SDK-call wrapped trace; service-principal ctx successfully reads workspace-private projects via the `isAdmin: true` short-circuit.

---

### U4. Swap sweep wiring + delete `verdictGenerator.ts`

**Goal:** Sweep's `buildVerdictForProject` calls `runDriftReasoning` instead of `generateDriftVerdict`. The focused evaluator and its tests are removed entirely. Sweep tests update their mocks to the new boundary.

**Requirements:** R5, R6

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `api/src/services/fleetgraph/sweep.ts`
- Modify: `api/src/services/fleetgraph/sweep.test.ts`
- Modify: `api/src/services/fleetgraph/sweep.concurrency.test.ts`
- Delete: `api/src/services/fleetgraph/verdictGenerator.ts`
- Delete: `api/src/services/fleetgraph/verdictGenerator.test.ts`

**Approach:**
- Add to `sweep.ts`:
  - `const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000' as const;` with a docstring: "Sentinel UUID for service-principal Fleet invocations. Do not change this value once shipped — code may compare against it to detect system-authored runs."
  - Import `runDriftReasoning` from `./index.js`.
- In `buildVerdictForProject` (~line 422):
  - Replace the `generateDriftVerdict(...)` call with:
    ```
    const ctx = { workspaceId: input.workspaceId, userId: SYSTEM_USER_ID, isAdmin: true };
    const result = await runDriftReasoning({
      entityId: input.subjectId,
      signals: input.signals,
      ctx,
      traceMetadata: { workspace_id: input.workspaceId, sweep_run_id: input.sweepRunId },
    });
    ```
  - Adapt the return shape: if `result.available` → use `result.verdict`; set `source: 'llm', degraded: false`; check `verdict.decision === 'SUPPRESS'` for the suppress branch as today. If `!result.available` → use the deterministic fallback; `source: 'deterministic', degraded: true`. Same `VerdictDecisionOutput` shape as today.
- Delete `verdictGenerator.ts` and `verdictGenerator.test.ts`. Confirm via grep that no other code imports them. The remaining trace-metadata pinning (workspace_id, sweep_run_id) is now provided at the entry-point boundary, not by the deleted module.
- Update `sweep.test.ts`:
  - Replace `vi.mock('./verdictGenerator.js', ...)` with `vi.mock('./index.js', ...)` exposing a mocked `runDriftReasoning`. The boundary the orchestrator-side tests mock is now the graph entry point, not the focused evaluator.
  - Update test scenarios to drive scenarios via mocked `runDriftReasoning`:
    - LLM-disabled path: mocked `runDriftReasoning` is NOT called.
    - LLM-enabled + SURFACE_ACT: mocked returns `{available:true, verdict:{decision:'SURFACE_ACT', ...}}` → substrate called with that verdict.
    - LLM-enabled + SUPPRESS: same shape, decision='SUPPRESS' → substrate skipped, `suppressed++`.
    - LLM-enabled + `{available:false}`: deterministic fallback + `degraded:true`.
  - All existing decision-matrix tests carry over verbatim, just with the new mock surface.
- Update `sweep.concurrency.test.ts`:
  - Replace `vi.mock('./verdictGenerator.js', ...)` with `vi.mock('./index.js', ...)`. Both C5 (SUPPRESS) and C6 (fallback) drive the same scenarios via mocked `runDriftReasoning` return shape instead of `generateDriftVerdict`.
- No SQL changes; no substrate changes; no settings changes.

**Patterns to follow:** existing sweep loop structure. Boundary mocking at the entry point sibling of `runPlanReview` follows the established `index.js` import shape.

**Test scenarios:**
- All existing sweep tests pass with the new mock boundary (the scenarios don't change, only what gets mocked changes).
- New scenario: assert sweep passes the correct `ctx` to `runDriftReasoning` — `workspaceId` from the loop, `userId: SYSTEM_USER_ID`, `isAdmin: true`.
- New scenario: assert sweep passes the correct `traceMetadata` — `workspace_id` matches the loop's workspaceId; `sweep_run_id` matches the per-tick UUID generated at the top of the sweep.
- Cross-workspace isolation continues to hold (existing test).

**Verification:** Sweep produces identical observable behavior for all decision branches (LLM-disabled, SURFACE_ACT, SURFACE_FYI, SUPPRESS, fallback), just routed through the graph. `verdictGenerator.ts` and its test are gone; no other code imports them.

---

### U5. Settings page caption update

**Goal:** Update the LLM verdicts toggle description on `/settings/fleet` to reflect that drift now reasons against full project context, not signals-only.

**Requirements:** R10

**Dependencies:** None (UI-only copy change)

**Files:**
- Modify: `web/src/pages/FleetGraphSettings.tsx`
- Modify: `web/src/pages/FleetGraphSettings.test.tsx` (if any test asserts the existing caption substring)

**Approach:**
- Find the existing LLM verdicts toggle's description paragraph (added in the LLM verdicts PR's U5). Replace the body text with: "When enabled, drift insights include reasoning from an AI model that reviews the project's plan and recent activity. Adds API costs per detected drift."
- No other UI changes.

**Patterns to follow:** existing settings copy.

**Test scenarios:** Test expectation: none — pure copy change; existing toggle behavior tests are unaffected. If an existing test asserts the description-text substring, update it.

**Verification:** Toggle's description renders the new sentence in the admin view of `/settings/fleet`.

---

## System-Wide Impact

- **Interaction graph:** drift now flows through the compiled FleetGraph (`getCompiledGraph()` singleton) — same graph instance the chat / plan-review / dedup callers use. Concurrent drift runs share the same compiled object (the graph is pure with respect to per-invoke `ctx`); the underlying `pg` pool handles the parallelism via the checkpointer's same connection pool used today.
- **AuthZ:** new service-principal pattern (sentinel `userId` + `isAdmin: true`) introduced solely for drift. Documented in the `SYSTEM_USER_ID` constant's comment. `VISIBILITY_FILTER_SQL`'s existing short-circuit is the only surface that interprets it.
- **Observability:** LangSmith traces gain a per-drift-project tree (root run + scope + fetch + reason + policy + output spans), filterable by `workspace_id` + `sweep_run_id` metadata both at the graph-root level (`RunnableConfig.metadata`) and at the per-SDK-call level (`evaluateStructured.metadata`).
- **Latency & cost:** per drifting project, a graph run now does up to one LLM call (the drift branch), same as the focused evaluator did. Plus the fetch is now a real DB query bundle instead of zero queries — adds maybe 50-150ms per project. Cost per call rises somewhat (prompt now includes plan text + activity, not just signals), but stays bounded by `maxTokens: 200` on the response.
- **Tests:** `graph.test.ts` grows with drift-mode integration scenarios; `verdictGenerator.test.ts` deleted; `sweep.test.ts` + `sweep.concurrency.test.ts` swap mock boundaries.
- **Unchanged invariants:** sweep's per-workspace advisory lock; sweep's deterministic detector (`computeProjectDrift`); the substrate's `createOrRefreshInsight` upsert semantics; the per-workspace toggle's storage shape; UI's existing toggle + degraded-warning surface.
- **Migrations:** none.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Adding `'drift'` to `FleetMode` triggers exhaustive-switch lint errors at every reason-node dispatcher / scope / fetch site that switches on mode without a default. | Audit + fix in U1/U2. The existing dispatcher in `reason.ts:244-276` is the only one I expect; scope/fetch are mode-agnostic. TS strict-mode will catch any missed site. |
| Graph timeout via `Promise.race` doesn't actually cancel the in-flight graph run — it just stops awaiting. The graph and its underlying SDK call continue executing and may finish (or never finish) in the background. | Acceptable v1. The graph eventually completes (or errors); the sweep just isn't waiting for it. No resource leak — pool connections release on completion. Document this in the entry point's JSDoc. If observed in practice, follow-up adds AbortController integration. |
| Sentinel `userId` is a UUID-shaped string but no actual user row exists with that ID. Code that joins on `users` from drift's path could fail. | Drift never touches the chat write-tools path (the only consumer of `users` join in the graph). Audit during implementation; if any join surfaces (e.g., in fetch enrichment), either LEFT JOIN or short-circuit the join when `ctx.userId === SYSTEM_USER_ID`. |
| Graph-routed drift is heavier than focused-evaluator drift. Workspaces with many drifting projects may see noticeably slower sweep ticks. | Sequential per-workspace iteration + advisory lock is unchanged. Tick latency is bounded by `(drifting projects) × (graph latency + LLM latency)`. The probe still short-circuits hash-matched projects. Acceptable v1; revisit if a workspace produces >50 drifting projects per tick (extreme edge). |
| Mocking strategy for `sweep.test.ts` shifts from `./verdictGenerator.js` to `./index.js` (the much bigger module). Existing test isolation may surface other index.js exports inadvertently. | Use `vi.importActual` + selective override on `runDriftReasoning` only, exactly like the LLM verdicts PR did for `verdictGenerator`. The boundary is established. |
| The drift prompt's "user message" carries project plan text — could be long. Prompt-budget overflow risks. | Bound the user message: truncate plan text to ~2000 chars; cap recent activity to last 10 items. Document the truncation in the prompt builder JSDoc. Revisit if observed verdict quality demands more context. |
| Trace metadata that flows through `traceMetadata` is a free-form `Record<string,string>` — could accidentally leak workspace-sensitive content into LangSmith. | Drift's caller (sweep) sets exactly two keys: `workspace_id` + `sweep_run_id`. Both are UUIDs. No user content reaches the metadata field. Documented in `runDriftReasoning`'s JSDoc. |
| Existing fleetgraph chat-concurrency test (`fleetgraph.test.ts > FleetGraph chat API > proposes a write (paused)` — flagged as pre-existing flake in the LLM verdicts PR) still flakes. | Not in scope. Continue flagging in PR description. |

---

## Sources & References

- **Sibling plan (just landed locally, PR pending):** `docs/plans/2026-05-28-002-feat-fleetgraph-llm-verdicts-plan.md` — focused-evaluator drift verdicts being superseded by this plan.
- **Surfacing plan (PR pending):** `docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md` — the substrate.
- **Architectural framing:** `docs/fleetgraph/presearch.md:48` — "same compiled graph; only the trigger differs."
- **Background:** `docs/fleetgraph/background.md` — endorses proactive (no-user-present) graph invocation.
- **Graph internals:** `api/src/services/fleetgraph/graph.ts`, `state.ts`, `nodes/reason.ts`, `nodes/scope.ts`, `nodes/fetch.ts`, `index.ts`.
- **Visibility helper:** `api/src/middleware/visibility.ts:65-80` — `isAdmin === true` short-circuit.
- **Service-principal precedent:** `docs/fleetgraph/background.md` proactive worker section.
- **Tests template:** `api/src/services/fleetgraph/graph.test.ts` for graph-entry-point integration tests.
