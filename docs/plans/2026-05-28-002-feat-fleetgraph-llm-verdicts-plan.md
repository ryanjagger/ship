---
title: "feat: LLM-backed verdicts for Fleet sweep insights"
type: feat
status: active
date: 2026-05-28
origin: (none — solo plan, builds on docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md)
---

# feat: LLM-backed verdicts for Fleet sweep insights

## Summary

Replace the sweep's deterministic templated verdict (`{decision, reasoning}` built from signal reasons) with an LLM-generated verdict that can also return `SUPPRESS` — the model's recommendation that a particular drift detection isn't actually worth surfacing. Gated per-workspace via a new toggle on the existing `/settings/fleet` page, not by a global env flag. Pre-prompt probe via a new lightweight `getInsightByIdentity` short-circuits the LLM call when the input-hash already matches an open insight, so refresh ticks stay free. Any LLM failure (provider down, parse error, network) falls back silently to the existing deterministic verdict and marks the sweep response `degraded: true` so the "Sweep now" UI can warn admins. SUPPRESS only blocks new detections — existing open insights are never auto-resolved by an LLM downgrade.

---

## Problem Frame

The shipped sweep (PR pending on `feature/fleetgraph-insight-surfacing`) produces insights whose `verdict` is a templated string: `"Project drift: idle 9d, plan stale 24d"` with `decision: 'SURFACE_ACT' | 'SURFACE_FYI'` mechanically chosen from signal count. The substrate supports `SUPPRESS` and free-form `reasoning` but the sweep can't generate either. This makes every drifting project look the same to the user — there's no signal that a project is genuinely worth attention vs. expected churn.

`docs/fleetgraph/presearch.md:51` describes the intended end state: "cheap SQL detectors gate the expensive model call so latency isn't spent on no-ops." The pieces already exist (`evaluateStructured` in `api/src/services/fleet-ai.ts`; LangSmith tracing via `wrapOpenAI`/`wrapAnthropic`; the deterministic verdict as a fallback). This plan wires them together at the sweep seam.

---

## Requirements

- R1. When the per-workspace `settings.fleetgraph.llm_verdicts_enabled` is `true`, the sweep produces verdicts by invoking `evaluateStructured` instead of the deterministic template. When `false` (default), behavior is unchanged from the shipped sweep.
- R2. The LLM returns one of `SURFACE_ACT`, `SURFACE_FYI`, or `SUPPRESS`. `SURFACE_ACT`/`SURFACE_FYI` produce an insight via `createOrRefreshInsight` as today. `SUPPRESS` causes the sweep to **skip creating an insight** for that project; it does NOT auto-resolve any existing open insight for the same `(workspace, subject, kind)`.
- R3. Before invoking the LLM for any drifting project, the sweep probes the existing insight (if any) by `(workspaceId, subjectId, kind)`. If a row exists in state `open` AND its `input_hash` matches the just-computed hash, the LLM is NOT called — the sweep dispatches a normal `createOrRefreshInsight` call which hits the substrate's existing no-op refresh branch.
- R4. On any LLM failure path (`isFleetAiError(result)` returns true, or the schema parse fails) the sweep falls back to the existing deterministic verdict (current shipped behavior) and increments a counter so the workspace tick can return `degraded: true`. No retries.
- R5. `SweepResult` gains two fields: `suppressed: number` (count of projects where the LLM returned `SUPPRESS`) and `degraded: boolean` (true if any LLM call fell back to deterministic during this tick).
- R6. The `/settings/fleet` page exposes a second admin-only toggle ("Use AI-generated verdicts") sibling to the existing "Enable scheduled sweep" toggle. Independent — sweep can be on with verdicts off, or vice versa for testing.
- R7. After a "Sweep now" that returned `degraded: true`, the settings page displays an inline warning ("AI fell back to deterministic verdicts for N project(s) this run") alongside the existing delta line.
- R8. The verdict prompt is **signals-only** in v1 — the model receives the drift signal list (type + reason strings) and project title, NOT the project plan text or recent issue activity. Smallest viable prompt; richer context is a deferred follow-up.
- R9. The persisted insight's `verdict` object carries the new `decision`/`reasoning` regardless of LLM vs deterministic source. **Source attribution** (LLM vs system) is captured in the `evidence` blob's `verdict_source` field (`'llm'` or `'deterministic'`); the substrate doesn't change shape. The UI's existing `InsightDetail` can later read `evidence.verdict_source` for a badge — that UI work is deferred to a follow-up.
- R10. Every LLM call is auto-traced by the existing `wrapOpenAI`/`wrapAnthropic` LangSmith wrappers in `api/src/services/fleet-ai.ts`. No explicit `traceable` wrapping required, but the verdict generator passes a `metadata` shape including `workspace_id` and `sweep_run_id` (a per-tick UUID) so LangSmith traces are filterable per workspace and sweep.

---

## Scope Boundaries

- LLM verdict generation only for `kind = 'project_drift'`. The substrate supports other kinds, but no other detector exists in v1.
- No retry on LLM failure. One try, fall back to deterministic.
- No batching across projects in a single prompt. One LLM call per drifting project per tick.
- No invocation of the full LangGraph compiled graph (`runPlanReview` / agent end-to-end). Direct `evaluateStructured` call only, mirroring `nodes/reason.ts:288` proactive pattern.
- No `FLEETGRAPH_LLM_VERDICTS_ENABLED` env flag. Per-workspace toggle only; ops emergency kill is a documented SQL one-liner.
- No prompt enrichment beyond signals in v1 (no plan text, no recent activity, no owner context).
- SUPPRESS does NOT auto-resolve existing open insights. SUPPRESS only blocks first-time detections that the LLM judges unworthy.
- No UI badge on `InsightDetail` distinguishing LLM-source from deterministic-source verdicts (the data is captured in evidence; the rendering is deferred).
- No per-LLM-call cost tracking / quota enforcement. LangSmith traces are the only observability.

### Deferred to Follow-Up Work

- UI source badge on `InsightDetail` showing "AI" vs "system" verdict.
- Richer prompt context (project plan text, recent issue movement, owner) — gated on observing v1 verdict quality.
- SUPPRESS auto-resolves existing open insights — re-evaluate once we see how often the LLM downgrades a detection that previously surfaced.
- Per-workspace LLM cost/quota tracking with a budget cap.
- Multi-kind detection (e.g., stalled issue, ownerless issue) — each would need its own prompt + schema.

---

## Context & Research

### Relevant Code and Patterns

**LLM call surface**
- `api/src/services/fleet-ai.ts` — exports `evaluateStructured<T>(req: FleetEvalRequest<T>): Promise<T | FleetAiError>` (signature at ~186). Never throws; returns `{ error: 'ai_unavailable' | 'ai_parse_error' }` on failure. Discriminator: `isFleetAiError(x)` at ~177.
- `api/src/services/fleet-ai.ts:25-26` — already wraps OpenAI/Anthropic SDKs with `wrapOpenAI` / `wrapAnthropic` from `langsmith/wrappers`. **Every call through `evaluateStructured` is auto-traced.** No additional `traceable` import needed for the verdict generator.
- `api/src/services/fleet-ai.ts:7` header comment — "evaluateStructured remains the structured-output utility used [by callers like nodes/reason.ts]". Direct call from the verdict generator matches this intended use.
- `api/src/services/fleetgraph/nodes/reason.ts:288` — canonical example of `evaluateStructured` invocation with Zod schema + structured response handling. Mirror this shape for the verdict generator.
- `api/src/services/fleetgraph/nodes/reason.ts:317` — second example (dedup) showing the same pattern repeated.
- `api/src/services/fleet-service.ts:264` — another `evaluateStructured` call site for additional reference shape.

**Sweep wiring point**
- `api/src/services/fleetgraph/sweep.ts` — `sweepWorkspaceDrift` is where the verdict construction happens today (the `buildInsightArgs` helper in the `__testing` export). The LLM path goes here. The advisory-lock + per-project-iteration structure is unchanged.
- The existing `inputHash` (SHA-1 over day-rounded signal inputs) is what the substrate uses for no-op refresh detection. **Same hash drives the new pre-prompt probe** — if hash matches an open insight, no LLM call needed.

**Insight substrate**
- `api/src/services/fleetgraph/insight.ts` — `CreateOrRefreshInsightArgs` (~131) accepts `verdict: InsightVerdict` and `inputHash: string`. The verdict shape is `{ decision: InsightVerdictDecision, reasoning: string }` where decision is `'SUPPRESS' | 'SURFACE_FYI' | 'SURFACE_ACT'`. **`SUPPRESS` is a valid decision the substrate already accepts**; the new behavior is that sweep doesn't even call the substrate on SUPPRESS.
- `api/src/services/fleetgraph/insight.ts:553` — `listInsights` (renamed in U4 of the surfacing plan). The new `getInsightByIdentity` follows the same visibility-free shape since it's a service-internal call with no user context.

**Workspace settings**
- `api/src/services/workspace-settings.ts` — `getFleetgraphSettings(workspaceId): Promise<FleetgraphSettings>`. Extending the interface adds `llmVerdictsEnabled: boolean` (defaults `false` when key missing). Add a sibling setter `setFleetgraphLlmVerdictsEnabled` mirroring `setFleetgraphSweepEnabled` at ~76.
- Migration 047 already created the `workspaces.settings` JSONB column. No new migration.

**Settings page (UI)**
- `web/src/pages/FleetGraphSettings.tsx` — the page just renamed to display "Fleet" in headings. Adding a second toggle row follows the existing sweep-toggle pattern (~219-231). The TanStack Query optimistic-mutation pattern at ~109-138 is the template.
- `web/src/pages/FleetGraphSettings.test.tsx` — supertest-equivalent for the page; add scenarios mirroring the existing sweep-toggle tests.

**OpenAPI**
- `api/src/openapi/schemas/workspace-settings.ts` — `FleetgraphSettingsSchema` + the PATCH body schema. Extend both to include `llmVerdictsEnabled`. The PATCH body becomes a partial — accepts either key independently.

**LangSmith metadata pattern**
- `docs/solutions/tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — wrappers handle trace creation; per-trace metadata (workspace_id, run id) needs to be passed explicitly. The verdict generator threads `workspaceId` and a per-tick `sweep_run_id` through.

### Institutional Learnings

- `docs/solutions/tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — proactive non-graph paths still trace via the SDK wrappers, but per-run metadata must be passed explicitly so traces are filterable. Surface `workspace_id` + `sweep_run_id` on the verdict generator.
- `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md` — write linkage in the same transaction as the parent row; verify via the visibility-scoped read path. Applicable here: when the LLM verdict path runs, the substrate's `createOrRefreshInsight` still owns the linkage write. The new probe `getInsightByIdentity` is read-only and doesn't introduce new linkage paths.

### External References

- None. `evaluateStructured` is a strong local pattern with 3+ existing call sites (`nodes/reason.ts` ×2, `fleet-service.ts`); LangSmith integration is documented and shipped; the prompt-design surface is a small focused task that doesn't benefit from external docs hunting.

---

## Key Technical Decisions

- **Per-workspace toggle, no env flag** (per user direction). Workspace admins control the cost switch via `/settings/fleet`. Emergency global kill is a one-line SQL update on the JSONB column (`UPDATE workspaces SET settings = jsonb_set(settings, '{fleetgraph,llm_verdicts_enabled}', 'false'::jsonb)`), documented in the rollout notes. Trade-off accepted: no boot-time env gate; the per-workspace check is one boolean read inside the existing per-workspace loop.

- **Two independent settings keys: `sweep_enabled` and `llm_verdicts_enabled`.** An admin might want sweep on with deterministic verdicts (zero cost) and flip LLM verdicts on later. Or LLM verdicts enabled but sweep paused for a maintenance window. Both keys default `false`. The setting page renders the LLM toggle below the sweep toggle with a short cost-disclaimer line.

- **Signals-only prompt in v1.** The prompt receives `{ projectTitle, signals: [{type, reason}, ...] }`. No plan text, no recent activity, no owner. Justification: ship the wiring first, observe verdict quality, enrich later if reasoning is too generic. Defers prompt-budget management until we have real LangSmith traces to learn from. (See `Deferred to Follow-Up Work` for the richer-context follow-up.)

- **No retry on LLM failure; immediate fallback to deterministic.** Retries add latency to a path that's already bounded by `SET LOCAL statement_timeout = '30s'`. The deterministic verdict is the safety net — silent fallback + degraded flag is enough signal to admins.

- **Pre-prompt probe via lightweight `getInsightByIdentity`.** Reads `(id, properties->'fleetgraph_insight'->>'state' AS state, properties->'fleetgraph_insight'->>'input_hash' AS input_hash)` from `documents` for `(workspace_id, subject_id, kind)`. No visibility filter (service-internal). When `state='open' AND input_hash = computedHash`, the LLM is NOT called — the sweep uses the existing deterministic verdict (which the substrate's no-op refresh branch will ignore anyway, since `inputHash` matches; only `occurrence_count` and `last_seen_at` advance). This is a belt-and-suspenders optimization: the substrate already protects against duplicate writes; the probe additionally avoids the LLM round-trip on the hot path.

- **SUPPRESS only blocks new detections** (conservative default per the call-out resolution). When the LLM returns `SUPPRESS`, the sweep increments a `suppressed` counter and skips the `createOrRefreshInsight` call entirely. An existing open insight for the same `(workspace, subject, kind)` is **not** auto-resolved — preserving user-actionable rows from being erased by an LLM bad day. If the underlying drift truly clears, the deterministic detector (`computeProjectDrift`) returns `null` next tick and the existing resolution path applies.

- **Degraded surfacing via `SweepResult.degraded: boolean`.** When any LLM call within a tick falls back, the per-workspace `SweepResult` returned by `sweepWorkspaceDrift` carries `degraded: true`. The `POST /api/insights/sweep` endpoint passes it through. The settings page's "Sweep now" success path displays a soft warning beside the delta line. No alerting/paging — just transparency to the admin who triggered the sweep.

- **Verdict source captured in `evidence.verdict_source`.** Each persisted insight gets either `evidence.verdict_source = 'llm'` (when the LLM produced the verdict) or `'deterministic'` (when LLM was disabled OR when fallback occurred). This goes through the existing free-form `evidence: Record<string, unknown>` blob — no schema change. Sets up the deferred UI badge work without coupling this PR to it.

- **`sweep_run_id` for trace filterability.** Generate a single UUID at the top of `sweepWorkspaceDrift` and pass it through to every `generateDriftVerdict` call within that tick. Include it in the LangSmith metadata so all traces from a sweep run are queryable as a group. Also stamped into `evidence.sweep_run_id` for cross-referencing insights ↔ traces.

- **No retry on Zod parse failure.** `evaluateStructured` returns `{error: 'ai_parse_error'}` if the provider returns malformed JSON despite the schema constraint. Treat the same as `ai_unavailable` — fall back, mark degraded. Repeated parse errors would suggest a prompt or schema problem, surfaced via the `degraded` flag, not auto-retried.

---

## Open Questions

### Resolved During Planning

- **Env flag vs per-workspace toggle:** per-workspace toggle on `/settings/fleet`. No env flag.
- **SUPPRESS handling for existing open insights:** SUPPRESS only blocks NEW detections; existing open rows are untouched.
- **Prompt context scope:** signals-only in v1; richer context deferred.
- **Concurrency within a tick:** sequential (no `Promise.all` across projects). Matches the existing per-workspace serial iteration; revisit when we see real-world tick latency.
- **Model choice:** reuse the existing `FLEET_AI_PROVIDER` default. No separate model selection for verdicts. The provider env already wires OpenAI/Anthropic; verdict generator inherits whichever is configured.
- **Degraded flag in SweepResult:** yes by default.
- **Trace tagging:** workspace_id + sweep_run_id passed via `evaluateStructured`'s metadata path. No explicit `traceable` wrapping — SDK wrappers already provide the trace.

### Deferred to Implementation

- **Exact prompt text** for the verdict generator's system + user messages. Settle while iterating against real traces — the plan locks the *shape* (signals-only) but not the exact words.
- **Whether to clamp the LLM-derived `severity` field on the insight.** The plan's substrate accepts `severity: 'fyi' | 'act'`. The LLM returns `decision` only; the sweep maps decision → severity (`SURFACE_FYI` → `'fyi'`, `SURFACE_ACT` → `'act'`, `SUPPRESS` → N/A). This is a mechanical mapping but the implementation should confirm against the actual `InsightVerdict` type at code-edit time in case the surfacing plan landed any signature change.
- **Whether the probe should also cache the computed hash to skip the inputs query on a subsequent tick.** Probably YAGNI; the inputs query is already part of the per-workspace aggregate SELECT, not an extra round-trip. Settle if perf observations suggest it.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
sweepWorkspaceDrift loop (one drifting project per iteration):
  ┌─ computeProjectDrift(inputs, now)              ← unchanged
  ├─ build deterministic verdict + inputHash        ← unchanged (kept as fallback)
  ├─ if !llmVerdictsEnabled  → use deterministic   ─→ createOrRefreshInsight (today)
  │
  ├─ probe: getInsightByIdentity(ws, subjectId, 'project_drift')
  │   returns { state, inputHash } | null
  │   if existing.state='open' && existing.inputHash===computedHash:
  │       → use deterministic; substrate no-op refresh ; skip LLM round-trip
  │
  ├─ generateDriftVerdict({ projectTitle, signals, workspaceId, sweepRunId })
  │     evaluateStructured<{decision, reasoning}>({
  │       system: "You are reviewing a drift detection ...",
  │       user: serialized signals + title,
  │       schema: LLMVerdictSchema,
  │       schemaName: 'DriftVerdict',
  │     })
  │     on FleetAiError → return { verdict: deterministicFallback, degraded: true }
  │     on success      → return { verdict: { decision, reasoning }, degraded: false }
  │
  ├─ if verdict.decision === 'SUPPRESS':
  │     suppressed++
  │     evidence.verdict_source = 'llm'  (logged but no insight created)
  │     continue   ← does NOT call createOrRefreshInsight; does NOT touch any existing open insight
  │
  └─ createOrRefreshInsight({ ...,
        verdict,
        evidence: { ...signalsEvidence, verdict_source, sweep_run_id }
     })

after the loop:
  return { workspaceId, scanned, created, refreshed, skipped, suppressed, degraded }
```

The settings page reads `degraded` from the manual-sweep response and renders a soft warning beside the existing delta line. The scheduled cron path logs `degraded` per workspace but has no UI surface.

---

## Implementation Units

### U1. workspace-settings extension for `llm_verdicts_enabled`

**Goal:** Extend the workspace-settings service and OpenAPI to carry a second per-workspace boolean alongside the existing `sweep_enabled`. Default `false`. Independent of the sweep toggle.

**Requirements:** R1, R6

**Dependencies:** None (extends shipped code from the surfacing plan)

**Files:**
- Modify: `api/src/services/workspace-settings.ts`
- Modify: `api/src/services/workspace-settings.test.ts`
- Modify: `api/src/openapi/schemas/workspace-settings.ts`
- Modify: `api/src/routes/workspaces.ts`

**Approach:**
- Extend `FleetgraphSettings` interface: add `llmVerdictsEnabled: boolean`.
- Update `getFleetgraphSettings(workspaceId)` to also read `settings.fleetgraph.llm_verdicts_enabled`, defaulting to `false` when missing. Strict `=== true` check, mirroring `sweepEnabled` to prevent stray string values from accidentally enabling.
- Add `setFleetgraphLlmVerdictsEnabled(workspaceId, enabled): Promise<FleetgraphSettings>` — single-statement `UPDATE workspaces SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{fleetgraph,llm_verdicts_enabled}', $1::jsonb, true) WHERE id = $2`. Mirrors the existing `setFleetgraphSweepEnabled` shape.
- Update `FleetgraphSettingsSchema` Zod object to include `llmVerdictsEnabled: z.boolean()`.
- Update PATCH body schema (`/api/workspaces/settings/fleetgraph`): accept partial — either `sweepEnabled`, `llmVerdictsEnabled`, or both. PATCH handler in `workspaces.ts` reads which key(s) are present and calls the matching setter(s).

**Patterns to follow:**
- `getFleetgraphSettings` / `setFleetgraphSweepEnabled` in `workspace-settings.ts` — exact mirror.
- Zod partial-update body shapes — check existing `workspaces.ts` PATCH handlers for the standard `z.object({...}).partial()` form.

**Test scenarios:**
- Happy path — `getFleetgraphSettings` on a workspace with `{fleetgraph: {sweep_enabled: true, llm_verdicts_enabled: true}}` returns `{sweepEnabled: true, llmVerdictsEnabled: true}`.
- Edge case — missing `llm_verdicts_enabled` key defaults to `false`; sweep_enabled remains independently readable.
- Edge case — `set` preserves the OTHER key (e.g., setting `llm_verdicts_enabled = true` on a workspace that already has `sweep_enabled = true` leaves the latter unchanged — single-statement `jsonb_set` only touches the named path).
- Edge case — strict `=== true` check: stored string `"true"` returns `llmVerdictsEnabled: false` (covered by an explicit test).
- PATCH endpoint — body `{sweepEnabled: true}` only updates sweep; body `{llmVerdictsEnabled: true}` only updates LLM verdicts; body with both updates both; empty body 400s.
- PATCH endpoint — non-admin still 403s for either or both fields.

**Verification:** Workspace can carry both flags independently; toggling one doesn't disturb the other; OpenAPI swagger reflects the new field; the PATCH route accepts partials.

---

### U2. `getInsightByIdentity` probe

**Goal:** Read-only lookup of the current insight row for `(workspace_id, subject_id, kind)` so the sweep can short-circuit before invoking the LLM.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `api/src/services/fleetgraph/insight.ts`
- Modify: `api/src/services/fleetgraph/insight.test.ts`

**Approach:**
- New export: `async getInsightByIdentity(workspaceId: string, subjectId: string, kind: InsightKind): Promise<{ id: string; state: InsightStatus; inputHash: string } | null>`.
- Single SELECT: `SELECT id, properties->'fleetgraph_insight'->>'state' AS state, properties->'fleetgraph_insight'->>'input_hash' AS input_hash FROM documents WHERE workspace_id = $1 AND document_type = 'insight' AND properties->'fleetgraph_insight'->>'subject_id' = $2 AND properties->'fleetgraph_insight'->>'kind' = $3 AND archived_at IS NULL AND deleted_at IS NULL ORDER BY (state = 'open') DESC LIMIT 1`.
- Service-internal (no visibility filter, no user context). The sweep is the only caller; visibility is enforced at read endpoints.
- Returns null when no row exists (workspace has never produced this insight).
- The partial unique index `insights_open_per_subject_kind` (migration 046) guarantees at most one OPEN row exists per `(workspace_id, subject_id, kind)`, so the ORDER BY collapses to "the OPEN row if any, otherwise the most-recent resolved/snoozed row".

**Patterns to follow:**
- Read-shape SQL in `insight.ts` for `getInsight` (`~633`); but no `discusses` join needed — this is a direct documents query.
- Use the existing `pool` from `../../db/client.js`.

**Test scenarios:**
- Happy path — workspace with one OPEN insight returns `{id, state:'open', inputHash}`; matches the inputHash stored on the row.
- Edge case — no row returns `null`.
- Edge case — only resolved rows exist → returns the most recent resolved row (`state:'resolved'`) so the sweep can see prior history if it wants; the sweep itself only uses the result when `state==='open'` and hash matches.
- Edge case — cross-workspace isolation: a row in workspace A with matching `(subject_id, kind)` does NOT match a query against workspace B.
- Edge case — deleted/archived rows are excluded.

**Verification:** Sweep can probe the substrate without locking, identifying the no-op case before any LLM call.

---

### U3. Verdict generator (LLM-backed evaluator)

**Goal:** Pure function that, given drift signals + workspace context, calls `evaluateStructured` and returns either the LLM verdict or the deterministic fallback. Carries the trace metadata.

**Requirements:** R1, R2, R4, R8, R10

**Dependencies:** None (uses shipped `evaluateStructured`)

**Files:**
- Create: `api/src/services/fleetgraph/verdictGenerator.ts`
- Create: `api/src/services/fleetgraph/verdictGenerator.test.ts`

**Approach:**
- Exports:
  - `interface VerdictInput { projectTitle: string; signals: DriftSignal[]; workspaceId: string; sweepRunId: string }`.
  - `interface VerdictOutput { verdict: InsightVerdict; degraded: boolean; source: 'llm' | 'deterministic' }`.
  - `async generateDriftVerdict(input: VerdictInput, deterministicFallback: InsightVerdict): Promise<VerdictOutput>`.
- Zod schema: `LLMVerdictSchema = z.object({ decision: z.enum(['SURFACE_ACT', 'SURFACE_FYI', 'SUPPRESS']), reasoning: z.string().min(1).max(1000) })`. Schema name: `'DriftVerdict'`.
- Build prompt:
  - `system`: "You are reviewing a drift detection for a Fleet project. Decide whether the detection should be surfaced to workspace members and why. Return one of SURFACE_ACT (urgent attention), SURFACE_FYI (informational), or SUPPRESS (not worth surfacing — drift signals are noise or expected). Provide concise reasoning grounded in the signals provided."
  - `user`: JSON-stringified `{ projectTitle, signals: input.signals.map(s => ({type: s.type, reason: s.reason})) }`.
  - Pass `maxTokens: 200` — reasoning is concise; this is a JSON response.
- Call `evaluateStructured<{decision, reasoning}>({system, user, schema: LLMVerdictSchema, schemaName: 'DriftVerdict', maxTokens: 200})`.
- On `isFleetAiError(result)`: return `{ verdict: deterministicFallback, degraded: true, source: 'deterministic' }`.
- On success: return `{ verdict: { decision: result.decision, reasoning: result.reasoning }, degraded: false, source: 'llm' }`.
- **LangSmith metadata:** `evaluateStructured` doesn't currently accept a metadata field per its signature. The minimum that's always trace-able is the SDK-wrapper auto-trace. To inject `workspace_id` and `sweep_run_id` per call, extend `FleetEvalRequest` minimally with an optional `metadata?: Record<string, string>` field that the wrappers pass through (LangSmith SDK wrappers honor a `langsmithExtra` per-call options object). This is an additive change to `fleet-ai.ts` that other callers ignore.

**Patterns to follow:**
- `api/src/services/fleetgraph/nodes/reason.ts:288` — the PROACTIVE branch's `evaluateStructured` call with Zod schema + structured response handling. The exact call shape (`isFleetAiError` discriminator, schema, schemaName) is the template.
- `api/src/services/fleet-service.ts:264` — second reference call site.

**Test scenarios:**
- Happy path — mocked `evaluateStructured` resolves to `{decision: 'SURFACE_ACT', reasoning: 'idle for two weeks'}` → returns `{verdict: that, degraded: false, source: 'llm'}`.
- Happy path — mocked result with `decision: 'SUPPRESS'` flows through unchanged; caller decides what to do.
- Edge case — mocked result with `decision: 'SURFACE_FYI'` flows through.
- Error path — mocked `evaluateStructured` returns `{error: 'ai_unavailable'}` → returns `{verdict: deterministicFallback, degraded: true, source: 'deterministic'}`.
- Error path — mocked returns `{error: 'ai_parse_error'}` → same fallback shape.
- Schema validation — when constructing the prompt, verify the SYSTEM prompt is non-empty and the user message contains the project title + all signal reasons (assert via mock-call capture).
- Metadata pass-through — `evaluateStructured` is called with `metadata: { workspace_id, sweep_run_id }` (assert via mock-call capture).
- Edge case — empty signals array → still calls the LLM (the caller decided this is a drifting project, so signals shouldn't be empty in practice; but no special-case branch needed).

**Verification:** Verdict generator produces a verdict from any input without throwing; degraded source signal is correctly propagated; the trace metadata makes it through to the SDK call.

---

### U4. Sweep wiring (probe + verdict route + suppress + degraded flag)

**Goal:** Integrate U2's probe and U3's generator into the sweep loop. Add `suppressed` and `degraded` to `SweepResult`. Capture `verdict_source` and `sweep_run_id` in evidence.

**Requirements:** R1, R2, R3, R4, R5, R9, R10

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `api/src/services/fleetgraph/sweep.ts`
- Modify: `api/src/services/fleetgraph/sweep.test.ts`
- Modify: `api/src/services/fleetgraph/sweep.concurrency.test.ts`
- Modify: `api/src/openapi/schemas/insights.ts` (extend `SweepResultSchema` with `suppressed: number, degraded: boolean`)

**Approach:**
- `SweepResult` gains `suppressed: number` and `degraded: boolean`.
- At the top of `sweepWorkspaceDrift`: generate `sweepRunId = crypto.randomUUID()`. Read `getFleetgraphSettings(workspaceId)` once to determine `llmVerdictsEnabled`. Initialize `degraded = false`, `suppressed = 0`.
- Per drifting project (existing loop):
  1. Build deterministic verdict + inputHash as today (kept as fallback).
  2. If `!llmVerdictsEnabled`: use deterministic verdict; set `evidence.verdict_source = 'deterministic'`; set `evidence.sweep_run_id = sweepRunId`; dispatch `createOrRefreshInsight` as today.
  3. Else, probe `getInsightByIdentity(workspaceId, projectId, 'project_drift')`. If returns `{state:'open', inputHash: existing}` and `existing === computedHash`: use deterministic verdict (the no-op refresh case — substrate skips most writes); set `evidence.verdict_source = 'deterministic'`, dispatch substrate. (The substrate's existing no-op refresh branch handles this efficiently.)
  4. Else (LLM verdicts enabled AND no matching open hash): call `generateDriftVerdict({projectTitle, signals, workspaceId, sweepRunId}, deterministicFallback)`. Read `{verdict, degraded: callDegraded, source}` from the result.
     - If `callDegraded` true → set tick-level `degraded = true`.
     - If `verdict.decision === 'SUPPRESS'`: `suppressed++`; log; skip `createOrRefreshInsight`; do NOT touch any existing open insight.
     - Else: build evidence `{ ...signalsEvidence, verdict_source: source, sweep_run_id: sweepRunId }`; dispatch `createOrRefreshInsight` with the LLM verdict.
- Return result with new fields.
- Update `__testing` exports to expose `buildVerdictForProject` (the helper that wraps the probe + generator decision) so unit tests can exercise the branching directly.

**Patterns to follow:**
- Existing `sweepWorkspaceDrift` structure — keep the BEGIN/lock/COMMIT shape and per-project bucketing exactly as shipped.
- Existing `__testing` namespace pattern for exposing internal helpers to unit tests.

**Test scenarios:**

Mocked-pool tests:
- Happy path — LLM verdicts disabled: every drifting project uses deterministic verdict; result `degraded: false, suppressed: 0`; substrate called with `evidence.verdict_source = 'deterministic'`.
- Happy path — LLM verdicts enabled, no existing insight, LLM returns `SURFACE_ACT`: substrate called with the LLM verdict + `verdict_source: 'llm'`.
- Happy path — LLM verdicts enabled, LLM returns `SUPPRESS`: substrate NOT called; `suppressed: 1`; no existing-insight read or write either.
- Probe hit — LLM verdicts enabled, existing OPEN insight with matching hash: LLM NOT called; substrate called with deterministic verdict (which will be the no-op refresh path).
- Probe miss — LLM verdicts enabled, existing OPEN insight with DIFFERENT hash: LLM called.
- LLM failure → fallback: mocked `evaluateStructured` returns `{error: 'ai_unavailable'}` → substrate called with deterministic verdict + `verdict_source: 'deterministic'`; tick result has `degraded: true`.
- Mixed tick — 3 projects: one with sweep+LLM both off (deterministic), one LLM enabled + SURFACE_ACT (LLM verdict), one LLM enabled + LLM fails (fallback + degraded). Result: `degraded: true`, two substrate calls.
- Multiple SUPPRESS in one tick → `suppressed: N` accumulates.
- Existing open insight + LLM returns SUPPRESS — assert NO call to `resolveInsight`; the open row is untouched.
- `sweep_run_id` consistency — same UUID is stamped into every evidence blob within one tick.

Real-Postgres concurrency tests (in `sweep.concurrency.test.ts`):
- A workspace with LLM verdicts enabled + a mock `evaluateStructured` that returns SUPPRESS: parallel sweeps both observe `suppressed:1`; no insight rows are created or modified.
- A workspace where LLM falls back: degraded flag observable in real result; insight is persisted with `evidence.verdict_source = 'deterministic'`.

**Verification:** Sweep correctly routes verdicts based on the per-workspace flag; SUPPRESS never persists an insight; existing open insights are untouched on SUPPRESS; degraded flag propagates correctly when fallback occurs.

---

### U5. UI: LLM toggle + degraded warning on `/settings/fleet`

**Goal:** Workspace admins can toggle LLM verdicts independently of the sweep, and see when a manual sweep degraded.

**Requirements:** R6, R7

**Dependencies:** U1, U4

**Files:**
- Modify: `web/src/pages/FleetGraphSettings.tsx`
- Modify: `web/src/pages/FleetGraphSettings.test.tsx`

**Approach:**
- Hook layer: extend the inlined `useUpdateFleetgraphSettingsMutation` to accept a partial body `{sweepEnabled?: boolean; llmVerdictsEnabled?: boolean}`. Optimistic update touches whichever key is present.
- Page renders a second toggle row under the existing sweep toggle, inside the same admin section:
  - Label: "Use AI-generated verdicts"
  - Below the label, small `text-muted` paragraph: "When enabled, drift insights include reasoning from an AI model. Adds API costs per detected drift. Disabled = fast deterministic verdicts."
  - Same Checkbox + optimistic mutation shape as the sweep toggle.
- After a successful "Sweep now", if the response has `degraded: true`, render an additional inline line beneath the existing delta line: `text-amber-500` color, "⚠ AI fell back to deterministic verdicts for some projects this run. (Check LangSmith for details.)" (existing delta line stays as the primary success line.)
- Non-admin view: read-only banner unchanged; do NOT render either toggle.

**Patterns to follow:**
- Existing sweep toggle structure in the same file (~219-231). Mirror its shape exactly.
- Optimistic mutation pattern in `useProjectsQuery.ts:247-292` (already mirrored once for the sweep toggle).
- Inline error / warning rendering in the same file (~233-237).

**Test scenarios:**
- Admin sees BOTH toggles. Non-admin sees the read-only banner only (no toggles).
- Toggle LLM ON → optimistic flip; PATCH body is `{llmVerdictsEnabled: true}` (NOT both keys); success keeps it on.
- Toggle LLM ON → PATCH fails → rolls back to off; inline error shown.
- Toggling sweep does NOT touch llmVerdictsEnabled in the optimistic cache (and vice versa).
- "Sweep now" success with `degraded: false` shows the standard delta line, no warning.
- "Sweep now" success with `degraded: true` shows the delta line AND the warning.
- "Sweep now" success with `suppressed > 0` includes that count in the delta line.

**Verification:** Both toggles work independently; degraded warning appears when applicable and is absent otherwise; non-admin is locked out of both controls.

---

## System-Wide Impact

- **Interaction graph:** Sweep service (modified), insight substrate (additive — new read function), workspace-settings (additive — second key), OpenAPI schemas (extended), settings page (additive toggle + warning). No other surfaces touched.
- **Cost surface:** Per-tick LLM cost is bounded by `(drifting projects with changed inputHash) × N`, where N is the per-call cost. The probe (U2) caps this at one LLM call per genuinely new/changed detection per tick. Refresh-only ticks make zero LLM calls.
- **AuthZ:** `workspaceAdminMiddleware` already gates both the LLM toggle (via the PATCH endpoint extended in U1) and the "Sweep now" trigger (unchanged from the surfacing PR). No new permission concepts.
- **Observability:** LangSmith traces auto-generate via the existing SDK wrappers in `fleet-ai.ts`. New metadata (`workspace_id`, `sweep_run_id`) makes traces filterable per workspace and per tick. The degraded flag is a soft user-visible signal; LangSmith is the deep-dive surface.
- **Data:** No schema changes. `workspaces.settings` JSONB gains an optional `llm_verdicts_enabled` key; insight `evidence` JSONB gains `verdict_source` and `sweep_run_id` keys (both optional, free-form per the substrate's `Record<string, unknown>` shape).
- **Unchanged invariants:** Existing deterministic verdict behavior is the default. The shipped sweep, REST endpoint, Insights mode, and resolve flow continue to work without modification when both toggles are off (which is the default for all workspaces post-deploy).
- **Rollout:** Default-off means zero behavior change post-deploy until an admin flips the LLM toggle. No migration, no backfill.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM cost spikes if an admin flips the toggle on a large workspace and the cron tick processes many drifting projects. | Probe (U2) ensures only changed/new detections call the LLM. Per-workspace toggle gives admin direct cost control. Emergency kill is a documented SQL one-liner. Future: cost cap (deferred). |
| LLM returns SUPPRESS on a project that's actually drifting badly, missing a real alert. | SUPPRESS only blocks first-time detection — the next tick will re-detect via `computeProjectDrift` and re-prompt. Existing open insights are never auto-resolved by SUPPRESS, so once a row exists, the LLM can't erase it. |
| LangSmith metadata doesn't reach the trace because `evaluateStructured` doesn't currently forward per-call options. | Minor additive change to `FleetEvalRequest` signature to pass-through `metadata` field; existing callers (which omit it) are unaffected. Verified during U3 implementation. |
| Probe returns stale data because the substrate's `createOrRefreshInsight` runs under a different transaction. | The probe is a read-committed snapshot; if the row changes mid-probe-to-write, the substrate's advisory lock + partial unique index catch the race. Probe is an optimization (skip LLM), not a correctness gate. |
| Mock test for `generateDriftVerdict` produces brittle prompt-text assertions that break when the prompt is refined. | Test only the *shape* (system non-empty, user contains title + signal reasons), not the exact words. Refinement is expected during real-world iteration. |
| LLM verdict text leaks workspace-sensitive content via LangSmith traces. | Prompt is signals-only in v1 (no plan text, no PII); signals carry generic threshold reasons ("idle 9 days") not user-content. Richer-context follow-up will need an explicit PII review before landing. |
| Per-tick `sweep_run_id` UUID is generated but not consumed beyond LangSmith metadata — feels like over-engineering. | The id costs essentially nothing (one `crypto.randomUUID()` per tick) and unlocks "show me all traces from this sweep run" queries in LangSmith with no extra plumbing. Keep. |

---

## Sources & References

- **Sibling plan (in flight):** `docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md` — the surfacing layer this builds on.
- **Architectural framing:** `docs/fleetgraph/presearch.md` line 51 — "cheap SQL detectors gate the expensive model call".
- **LLM call surface:** `api/src/services/fleet-ai.ts` (`evaluateStructured`, `isFleetAiError`, SDK wrapping).
- **Canonical call template:** `api/src/services/fleetgraph/nodes/reason.ts:288` (PROACTIVE branch).
- **LangSmith tracing convention:** `docs/solutions/tooling-decisions/langsmith-two-tier-tracing-for-fleet.md`.
- **Linkage hardening:** `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md`.
