---
title: "feat: Project Drift Detection (per-project drift badge)"
type: feat
status: completed
date: 2026-05-27
origin: docs/brainstorms/2026-05-27-project-drift-detection-requirements.md
---

# feat: Project Drift Detection (per-project drift badge)

## Summary

Compute a per-project `drift` object on-read and expose it on the project API response, then render a small badge on Projects list rows and on the project detail view. Drift is derived from per-project SQL aggregates (issue movement timestamps, plan-edit recency, incomplete-issue counts) passed into a pure, unit-tested threshold function — no stored state, no background sweep.

---

## Problem Frame

Ship already stores everything needed to tell when an `active`/`planned` project is quietly slipping (issue timestamps, plan edit history via `document_history`, association-joined issue counts) but surfaces none of it; drift is only discoverable by manual project-by-project inspection. See origin doc for the full pain narrative (Sources & References).

---

## Requirements

- R1. Drift is computed only for projects whose inferred status is `active` or `planned`; `completed`/`backlog`/`archived` never produce a badge. (origin R1)
- R2. Drift is computed on-read as derived state, mirroring how `inferred_status` is produced — no stored drift, no sweep, no push. (origin R2)
- R3. *Idle / no movement* fires when an eligible project has ≥1 open issue (`state` in `todo`/`in_progress`) and no associated issue has changed state or been created within 7 days. (origin R3)
- R4. *Stale plan* fires when the project's plan was last edited > 21 days ago; a project with no plan at all also fires this signal with a distinct label. (origin R4)
- R5. *Rising incomplete work* fires when the count of incomplete issues is ≥ 2 higher now than 7 days ago. (origin R5)
- R6. The badge appears when ≥ 1 signal fires, lists each fired signal with a human-readable reason, and shows severity = number of signals fired. (origin R6)
- R7. Badge is display-only — no acknowledge/snooze/ask-Fleet/follow-up actions. (origin R7)
- R8. Badge renders on Projects list rows and on the project detail view. (origin R6 + planning decision: List + detail page)

**Origin actors:** none defined (drift is unrouted computed state visible to any workspace member).
**Origin acceptance examples:** AE1 (R1), AE2/AE3 (R3), AE4 (R4), AE5 (R5), AE6 (R6).

---

## Scope Boundaries

- The four human actions (acknowledge, snooze, ask FleetGraph, create follow-up) — display-only this version. (origin)
- A fleet-wide aggregate drift view / dashboard. (origin)
- Person-scoped signals (no recent standups, slipping week docs) — excluded; person→project mapping judged too fuzzy. (origin)
- Workspace-configurable thresholds — fixed balanced constants (7d / 21d / +2). (origin)
- FleetGraph root-cause integration. (origin)

### Deferred to Follow-Up Work

- Drift severity color-coding refinements / dedicated styling beyond reusing the existing pill convention: future iteration if the badge proves useful.

---

## Context & Research

### Relevant Code and Patterns

- `api/src/routes/projects.ts` — `extractProjectFromRow` (~lines 181–236) is the single enrichment seam both the list handler (CTE query, ~538–609) and the GET-single handler (correlated subqueries, ~628–707) funnel rows through. `inferred_status`, `issue_count`, `sprint_count` are already SQL-computed columns read here — drift aggregates follow the same shape. Eligibility maps to `inferred_status IN ('active','planned')`.
- `api/src/utils/document-crud.ts` — `getTimestampUpdates` (~78–101) defines when `started_at`/`completed_at`/`cancelled_at`/`reopened_at` are set; `logDocumentChange` (~47–62) writes `document_history` rows; the project PATCH handler logs `field='plan'` on plan edits.
- Per-project issue fetch joins `document_associations da ON da.document_id = d.id AND da.related_id = $project AND da.relationship_type = 'project'` (projects.ts ~1438–1459).
- `api/src/db/schema.sql` — `document_history` (~225–234: `field`, `created_at`, indexed `(document_id, created_at DESC)`); issue timestamp columns (~138–142).
- `shared/src/types/document.ts` — `IssueState = 'triage'|'backlog'|'todo'|'in_progress'|'in_review'|'done'|'cancelled'` (~47); `ProjectProperties` (~105). New `Drift`/`DriftSignal` types go here, re-exported via `shared/src/types/index.ts` → `shared/src/index.ts`.
- `web/src/hooks/useProjectsQuery.ts` — the `Project` interface (~8–49) is where the web-side `drift` field is added (response type is NOT shared; it is declared inline both api-side and web-side).
- `web/src/pages/Projects.tsx` — `ProjectRowContent` (~481–566); existing "Incomplete" pill (~496–500) is the small-pill convention to mirror; `ICEBadge` (~568–584) is the local severity-color pattern.
- `web/src/components/document-tabs/ProjectDetailsTab.tsx` — detail view; does NOT currently consume the enriched GET-single response (renders from a passed `document` prop), so U5 wires that in.
- `api/src/routes/projects.test.ts` — Vitest + supertest with `vi.mock('../db/client.js')` mocking `pool.query`; queue rows via `mockResolvedValueOnce`, assert `res.body`.

### Institutional Learnings

- `docs/solutions/integration-issues/claude-context-api-for-ai-skills.md` — prior art for pre-computing derived signals server-side and returning them as a structured sub-object; mirror that stance.
- `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md` — issues link to a project ONLY via `document_associations` (not legacy `project_id`); orphaned issues (zero association rows) are a real observed state and correctly fall out of per-project drift counts.

### External References

- None — internal Express/`pg`/React patterns with strong local examples; no external research warranted.

---

## Key Technical Decisions

- **SQL aggregates + pure TS threshold function (hybrid):** Each project query computes raw per-project columns (last-movement timestamp, plan-last-edited timestamp, plan presence, incomplete-now count, incomplete-7d-ago count) as additional SQL columns alongside `inferred_status` — no N+1 across the list. A pure function `computeProjectDrift(inputs, now)` applies the thresholds and assembles the `Drift` object inside `extractProjectFromRow`. Keeps threshold logic unit-testable (the existing route tests mock `pool`, so SQL logic itself is only integration-testable; the pure function is directly testable).
- **Plan-edit recency from `document_history` (field `'plan'`), not `plan_history`:** `plan_history` is a sprint-only field; projects log plan edits to `document_history`. Effective plan-edit time = `COALESCE(MAX(document_history.created_at WHERE field='plan'), project.created_at)` so a plan set at creation (never re-edited, no history row) ages from creation rather than being mislabeled "no plan". "No plan" is the separate case where `properties->>'plan'` is null/empty.
- **Two distinct issue sets.** *Open* (for the idle gate) = `state` in `todo`/`in_progress` only, per origin R3 — triage/backlog/in_review do not by themselves make a project "idle". *Incomplete* (for the rising-work signal, R5) = `state` NOT IN (`done`,`cancelled`), the broader set. These are deliberately different and computed as separate aggregates.
- **Movement = issue state-change timestamps + creation:** last-movement = GREATEST of MAX(`created_at`,`started_at`,`completed_at`,`cancelled_at`,`reopened_at`) over associated issues. Content edits (`updated_at`) are intentionally excluded — collaborative autosave would make them too noisy to mean "progress".
- **Thresholds as named constants (7d / 21d / +2)** colocated with `computeProjectDrift`, not workspace-configurable (origin scope).
- **`drift` is `null` for ineligible projects; `{ isDrifting, signals }` for eligible ones** (empty `signals` when none fire). Web renders the badge only when `isDrifting`.

---

## Open Questions

### Resolved During Planning

- *Authoritative source for "plan last edited"* (origin deferred): `document_history` rows with `field='plan'`, COALESCEd to project `created_at`. `plan_history` is sprint-only — not used.
- *Reconstructing the 7-days-ago incomplete count* (origin deferred): purely from issue timestamps — an issue counts as incomplete-then if `created_at <= now-7d` AND it was not yet done/cancelled at that point (`completed_at`/`cancelled_at` null or `> now-7d`). No stored history needed.

### Deferred to Implementation

- Exact SQL formulation of the per-project aggregates (single CTE vs lateral subqueries) — settle against the live query shapes in `projects.ts` during implementation; the list path must avoid per-row round-trips.
- On-read cost of the added aggregates across large project lists — no prior guidance exists; measure during implementation and capture with `/ce-compound` if it bites (origin deferred, `[Needs research]`).
- Approximation error in the timestamp-reconstructed 7d-ago count for issues with reopen/cancel churn — accepted. Specific mechanism: `getTimestampUpdates` sets `completed_at = COALESCE(completed_at, NOW())` (captures only the *first* completion and is never cleared on reopen), while `reopened_at` is overwritten on each reopen. So a done-then-reopened issue retains its original `completed_at` and the "was incomplete 7d ago" test (`completed_at`/`cancelled_at` null or `> now-7d`) will misclassify it as complete-then. Bound the impact in U2 tests with at least one reopened-issue scenario; revisit only if it produces visibly wrong "rising" badges in practice.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Project query (list CTE / single subquery)
  ── computes per project, alongside inferred_status ──>
     inferred_status
     last_movement_at        = GREATEST(MAX created_at/started_at/completed_at/cancelled_at/reopened_at over associated issues)
     plan_text               = properties->>'plan'
     plan_last_edited_at      = COALESCE(MAX(document_history.created_at WHERE field='plan'), project.created_at)
     open_now                 = COUNT(issues, state IN todo/in_progress)
     incomplete_now           = COUNT(issues, state NOT IN done/cancelled)
     incomplete_7d_ago        = COUNT(issues existing 7d ago & not yet done/cancelled then)
                  │
                  ▼
extractProjectFromRow(row)
  └─ computeProjectDrift({ inferredStatus, lastMovementAt, planText, planLastEditedAt,
                           openNow, incompleteNow, incomplete7dAgo }, now)
        ├─ inferredStatus ∉ {active, planned}            → null
        ├─ idle:     openNow>0 && lastMovementAt < now-7d           → signal "idle Nd"
        ├─ stale:    planText empty                                 → signal "no plan"
        │            else planLastEditedAt < now-21d                → signal "plan stale Nd"
        └─ rising:   incompleteNow - incomplete7dAgo >= 2           → signal "incomplete work +N in 7d"
        ⇒ { isDrifting: signals.length>0, signals }
                  │
                  ▼
   API response.drift  ──>  web Project.drift  ──>  <DriftBadge> (list row + detail view)
```

---

## Implementation Units

### U1. Shared Drift types

**Goal:** Define the `Drift` / `DriftSignal` types once in shared so both api and web import them.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `shared/src/types/document.ts` (add `DriftSignalType`, `DriftSignal`, `Drift`)
- Modify: `shared/src/types/index.ts` (re-export if not wildcard)

**Approach:**
- `DriftSignalType = 'idle' | 'stale_plan' | 'rising_incomplete_work'`.
- `DriftSignal = { type: DriftSignalType; reason: string }` (`reason` is the human-readable string, e.g. "idle 9 days").
- `Drift = { isDrifting: boolean; signals: DriftSignal[] }`.
- Project response carries `drift: Drift | null` (null = ineligible / not evaluated).

**Patterns to follow:** existing type + re-export style in `shared/src/types/document.ts`.

**Test scenarios:** Test expectation: none — pure type declarations, exercised by U2/U3 tests. Verify `pnpm build:shared` type-checks.

**Verification:** `@ship/shared` exports `Drift`, `DriftSignal`, `DriftSignalType`; importable from both api and web.

---

### U2. Pure drift computation function

**Goal:** Implement `computeProjectDrift(inputs, now)` — the threshold logic that turns raw per-project aggregates into a `Drift | null`. This is the feature-bearing core.

**Requirements:** R1, R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- Create: `api/src/services/drift/computeProjectDrift.ts`
- Create: `api/src/services/drift/computeProjectDrift.test.ts`

**Approach:**
- Input shape: `{ inferredStatus, lastMovementAt: Date | null, planText: string | null, planLastEditedAt: Date | null, openNow: number, incompleteNow: number, incomplete7dAgo: number }`, plus injected `now` for deterministic tests. (`openNow` = count of `todo`/`in_progress` issues, gates idle; `incompleteNow`/`incomplete7dAgo` = non-done/cancelled, drive rising work.)
- Named constants: `IDLE_DAYS = 7`, `STALE_PLAN_DAYS = 21`, `RISING_WORK_MIN_DELTA = 2`.
- Eligibility gate first: return `null` unless `inferredStatus` is `active` or `planned`.
- **Defensive on missing inputs:** treat `undefined`/`NaN` aggregate inputs as absent (e.g. `lastMovementAt`/`planLastEditedAt` → null, counts → 0) and return `null`/`{isDrifting:false,signals:[]}` rather than throwing. This makes the function safe to call from project response paths whose row was synthesized without the drift columns (see U3 call-site note).
- Idle: fires when `openNow > 0` and `lastMovementAt` is older than `IDLE_DAYS`; reason `"idle {N} days"` (N = whole days since last movement). If `lastMovementAt` is null (no issues) idle does not fire.
- Stale plan: empty/whitespace `planText` → `"no plan"`; else `planLastEditedAt` older than `STALE_PLAN_DAYS` → `"plan stale {N} days"`.
- Rising work: `incompleteNow - incomplete7dAgo >= RISING_WORK_MIN_DELTA` → `"incomplete work +{delta} in 7d"`.
- Assemble `signals` in fixed order (idle, stale_plan, rising_incomplete_work); `isDrifting = signals.length > 0`.

**Execution note:** Implement test-first — this unit is pure logic with exact thresholds and is the highest-value place for table-driven coverage.

**Patterns to follow:** existing pure helpers under `api/src/services/` and `api/src/utils/`; date math consistent with `document-crud.ts`.

**Test scenarios:**
- Covers AE1. Edge case — `inferredStatus='backlog'` with old movement and no plan → returns `null` (no badge for ineligible).
- Edge case — `inferredStatus='completed'`/`'archived'` → `null`.
- Covers AE2. Happy path — `active`, `openNow=4` (todo/in_progress), `lastMovementAt` 9 days ago → idle fires, reason "idle 9 days".
- Covers AE3. Edge case — `active`, `openNow=0` (all done), `lastMovementAt` 30 days ago → idle does NOT fire.
- Edge case — `active`, `openNow=0` but `incompleteNow>0` (only triage/backlog/in_review issues), `lastMovementAt` 30 days ago → idle does NOT fire (only todo/in_progress gate idle).
- Edge case — `active`, idle exactly at boundary (`lastMovementAt` 7 days vs 6 days ago) → fires at >7d, not at ≤7d.
- Covers AE4. Happy path — `planLastEditedAt` 24 days ago → stale_plan "plan stale 24 days"; empty `planText` → stale_plan "no plan".
- Edge case — `planText` present, `planLastEditedAt` 10 days ago → stale_plan does NOT fire.
- Covers AE5. Happy path — `incompleteNow=5`, `incomplete7dAgo=3` (+2) → rising fires "incomplete work +2 in 7d"; `+1` → does NOT fire.
- Edge case — reopened-issue approximation: an issue completed >7d ago then reopened is counted complete in the 7d-ago figure (documents the known `completed_at` COALESCE limitation rather than asserting perfect accuracy).
- Covers AE6. Integration of signals — `active` with idle + stale_plan true, rising false → `isDrifting=true`, `signals.length=2`, both reasons present, order [idle, stale_plan].
- Edge case — eligible project, no signals fire → `{ isDrifting: false, signals: [] }` (not null).

**Verification:** `computeProjectDrift.test.ts` passes; thresholds isolated as constants; function is pure (same inputs + `now` → same output).

---

### U3. API enrichment — drift aggregates + wiring

**Goal:** Add the per-project raw aggregate columns to both project queries and assemble `drift` in `extractProjectFromRow` via `computeProjectDrift`.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** U1, U2

**Files:**
- Modify: `api/src/routes/projects.ts` (list CTE query, GET-single subqueries, `extractProjectFromRow`)
- Modify: `api/src/routes/projects.test.ts`

**Approach:**
- Extend both query shapes with the raw columns (`last_movement_at`, `plan_text`/reuse existing plan selection, `plan_last_edited_at`, `open_now`, `incomplete_now`, `incomplete_7d_ago`), aggregating over the `relationship_type='project'` issue join and a `document_history` subquery for `field='plan'`. `open_now` counts `todo`/`in_progress`; `incomplete_*` count non-done/cancelled. Reuse the existing `inferred_status` computation untouched.
- In `extractProjectFromRow`, read the new columns and call `computeProjectDrift({...}, new Date())`; set `drift` on the returned object. Ineligible rows naturally yield `null` from the function.
- Keep `extractProjectFromRow` synchronous — all inputs arrive as row columns (no extra round-trips).
- **Cover all `extractProjectFromRow` call sites.** It is called from the list handler and GET-single handler (both get the new columns) AND from the POST-create and PATCH-requery paths, which synthesize a row inline (e.g. `{ ...result.rows[0], inferred_status: 'backlog' }`) that does NOT include the drift aggregate columns. Either add the aggregate columns to those paths' queries OR rely on U2's defensive handling so those rows emit `drift: null` (a freshly-created `backlog` project is ineligible anyway). Whichever, verify create/patch responses do not throw and return `drift: null`.

**Patterns to follow:** the existing `inferred_status` / `issue_count` SQL-column-then-read-in-`extractProjectFromRow` pattern.

**Test scenarios:**
- Happy path — GET `/api/projects` with a mock row carrying eligible status + idle-triggering aggregates → response item has `drift.isDrifting=true` with an idle signal.
- Edge case — mock row with ineligible `inferred_status` → `drift` is `null` in the response.
- Covers AE6. Happy path — GET `/api/projects/:id` with two signals' aggregates → `drift.signals` length 2 in the single-project response.
- Integration — assert the emitted SQL (`pool.query.mock.calls`) includes the new aggregate columns / `document_history` join for `field='plan'` (guards the query shape).
- Edge case — eligible row, no signals → `drift = { isDrifting:false, signals:[] }`.
- Edge case — POST `/api/projects` (create) and PATCH response paths, whose synthesized row lacks drift columns → response returns `drift: null` and does not throw.

**Verification:** both list and single endpoints return a correct `drift` field; existing project tests still pass; no added round-trips per project.

---

### U4. Web — drift badge on Projects list rows

**Goal:** Surface `drift` on the web `Project` type and render a badge in list rows when `isDrifting`.

**Requirements:** R6, R7, R8

**Dependencies:** U3

**Files:**
- Modify: `web/src/hooks/useProjectsQuery.ts` (add `drift: Drift | null` to `Project`)
- Create: `web/src/components/DriftBadge.tsx`
- Modify: `web/src/pages/Projects.tsx` (render `<DriftBadge>` in `ProjectRowContent`)
- Test: `web/src/components/DriftBadge.test.tsx`

**Approach:**
- `DriftBadge` takes `drift: Drift | null`; renders nothing when `null` or `!isDrifting`; otherwise a small pill showing the severity (signal count).
- **Reasons via `aria-label`, not the `title` attribute.** Render the pill as a non-interactive `<span>` (no focus stop, since it is display-only per R7) with `aria-label="Drift: {reason1}, {reason2}, …"` so screen readers get the full reason list. The native `title` attribute is keyboard/touch-inaccessible and must not be the surfacing mechanism. A visible reason list (e.g. on hover) is optional polish, but the accessible name is the contract.
- **Interim severity styling is uniform.** All severity levels (1–3) use the same single pill style for now; per-severity color-coding is explicitly deferred (Scope Boundaries → Deferred to Follow-Up Work). The visible severity count is the differentiator.
- Mirror the existing "Incomplete" pill Tailwind classes (Projects.tsx ~496–500); place next to the title pill in `ProjectRowContent`.
- Display-only — no action handlers (R7).

**Patterns to follow:** "Incomplete" pill (`Projects.tsx` ~496–500); `ICEBadge` (~568–584) for severity-driven coloring if desired.

**Test scenarios:**
- Happy path — `drift.isDrifting=true` with 3 signals → badge renders showing severity 3 and all three reasons present in the `aria-label`.
- Edge case — `drift=null` → renders nothing.
- Edge case — `drift.isDrifting=false` (eligible, no signals) → renders nothing.
- Accessibility — badge is a non-focusable span exposing reasons via `aria-label` (no reliance on `title`).

**Verification:** Projects list shows the badge only on drifting projects; reasons are reachable by screen readers via the accessible name; non-drifting and ineligible projects show no badge.

---

### U5. Web — drift badge on project detail view

**Goal:** Wire the enriched GET-single project response into the detail view and render the badge there.

**Requirements:** R8

**Dependencies:** U3, U4

**Files:**
- Create: `web/src/hooks/useProjectQuery.ts` (single-project query against `GET /api/projects/:id`, exposing the enriched `drift` field)
- Modify: `web/src/components/document-tabs/ProjectDetailsTab.tsx` (call `useProjectQuery`, render `<DriftBadge>`)

**Approach:**
- `ProjectDetailsTab` today renders from a passed `DocumentResponse` `document` prop and never calls the projects API (it PATCHes `/api/documents/:id` against the document model). The enriched `drift` lives only on the projects-API responses, and there is no existing single-project query hook — so add a focused `useProjectQuery(id)` (mirroring `useProjectsQuery`'s TanStack Query pattern) rather than threading `drift` through the generic document model. *(Decision; alternative — thread `drift` onto `DocumentResponse` — rejected: it couples a project-only field to the shared document path.)*
- **Placement:** render `<DriftBadge>` inline immediately after the project title in the detail header (same row as the title), consistent with the list-row placement next to the title pill.
- **No separate loading state:** `drift` arrives in the same `useProjectQuery` payload as the rest of the project; while the query is pending the badge simply does not render (same as the `null` branch). No spinner, no skeleton for the badge specifically.
- Reuse the same `<DriftBadge>` from U4 (do not duplicate).

**Patterns to follow:** existing query hooks in `web/src/hooks/`; `DriftBadge` from U4 (reused, not duplicated).

**Test scenarios:**
- Happy path — detail view for a drifting project renders `<DriftBadge>` with the correct severity/reasons.
- Edge case — detail view for a non-drifting or ineligible project renders no badge.
- Integration — the badge on the detail view reflects the same `drift` data the list row shows for the same project (single source: the enriched project response).

**Verification:** opening a drifting project shows the badge on the detail view; consistent with the list-row badge; no duplicate `DriftBadge` implementation.

---

## System-Wide Impact

- **Interaction graph:** Only the project read path (`extractProjectFromRow` and the two project queries) and two web render sites. No writes, no mutations, no new endpoints.
- **Error propagation:** Drift computation is best-effort enrichment; a null/undefined aggregate must degrade to "no badge", never throw or break the project response. `computeProjectDrift` returns `null`/empty rather than erroring on missing inputs.
- **State lifecycle risks:** None — purely derived on read, nothing persisted.
- **API surface parity:** Both list and single project responses must carry `drift` identically (U3 covers both); the web `Project` type and the api response object are declared separately and both must gain the field.
- **Integration coverage:** That eligible+signal aggregates actually produce a badge end-to-end is proven by U3 route tests (api shape) + U4/U5 render tests; the SQL aggregate correctness itself is only integration-testable under the mocked-pool harness — flagged in Risks.
- **Unchanged invariants:** `inferred_status`, `issue_count`, `sprint_count`, and all existing project response fields are untouched; drift is purely additive.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SQL aggregate logic is not exercised by the mocked-pool unit tests (only the TS threshold function and response wiring are) | Keep all threshold logic in the pure `computeProjectDrift` (fully unit-tested); assert query-shape in U3; rely on manual/integration verification for the SQL aggregates. Capture a learning if the SQL proves error-prone. |
| Added aggregates slow the project list query at scale | Aggregate within the existing query (no N+1); `document_history` is indexed on `(document_id, created_at DESC)`; measure on-read cost during implementation (deferred question). |
| Timestamp-reconstructed 7d-ago count mis-handles reopen/cancel churn | Accepted approximation; documented; revisit only if visibly wrong "rising" badges appear. |
| Plan-edit recency wrong when a plan was set at creation with no `document_history` row | `COALESCE(MAX(history.created_at), project.created_at)` ages from creation rather than mislabeling "no plan". |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-27-project-drift-detection-requirements.md](docs/brainstorms/2026-05-27-project-drift-detection-requirements.md)
- Related code: `api/src/routes/projects.ts` (`extractProjectFromRow`), `api/src/utils/document-crud.ts`, `web/src/pages/Projects.tsx`, `web/src/components/document-tabs/ProjectDetailsTab.tsx`
- Related learnings: `docs/solutions/integration-issues/claude-context-api-for-ai-skills.md`, `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md`
