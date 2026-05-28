---
title: "feat: FleetGraph insight surfacing layer (sweep, read endpoint, UI)"
type: feat
status: completed
date: 2026-05-28
origin: (none — solo plan, but builds on docs/plans/2026-05-27-002-feat-fleetgraph-insight-entity-plan.md and reuses docs/plans/2026-05-27-001-feat-project-drift-detection-plan.md thresholds)
---

# feat: FleetGraph insight surfacing layer (sweep, read endpoint, UI)

## Summary

Turn the shipped insight substrate (`createOrRefreshInsight`, `resolveInsight`, `listOpenInsights`, `getInsight` from PR #41 on `feature/fleet`) into a working end-to-end loop. Three coordinated additions: (1) an in-process `node-cron` **sweep** that detects per-project drift workspace-wide and persists `kind=project_drift` insights, reusing the existing `computeProjectDrift` thresholds; (2) **REST endpoints** that expose the insights visibility-scoped and allow resolution and on-demand sweeps; (3) a **UI surface** consisting of a new "Insights" icon-rail mode (list + detail, resolve action) plus a `/settings/fleetgraph` page with a per-workspace toggle and "sweep now" button. Per-workspace toggle stored in a new `workspaces.settings` JSONB column (migration 047). Defaults to disabled — sweep is opt-in per workspace.

The shipped drift badge (`<DriftBadge>` on project rows / detail) is **kept**: it remains the per-project at-a-glance signal with no memory; insights are the persistent, workspace-wide, resolvable surface. Both consume the same `computeProjectDrift` to stay semantically aligned.

---

## Problem Frame

PR #41 landed the insight document type and CRUD primitives — but no code calls them. The substrate is dark: no detector produces insights, no endpoint reads them, no UI shows them. A workspace member who wanted to find drifting projects today still has to click into each project and read the on-page badge; there is no "show me everything drifting across this workspace" view, no resolution state ("I've handled this"), and no way for the system to notice drift between visits.

This plan closes that gap with the minimum surface that exercises the substrate end-to-end: a single detector kind (`project_drift`), a single list+detail UI mode, and an opt-in scheduled sweep. It deliberately keeps the on-read drift badge as a parallel signal — they answer different questions ("is this project drifting *right now*?" vs. "what drift do I need to act on across the workspace?").

---

## Requirements

- R1. A periodic in-process scheduled sweep runs on the API process at a fixed cadence (default hourly) and, for each workspace that has the sweep enabled, iterates eligible projects and calls `createOrRefreshInsight({ kind: 'project_drift', subjectId: projectId, ... })` for those currently drifting.
- R2. The sweep MUST NOT double-fire across multiple API instances. A per-workspace single-flight discipline using a non-blocking Postgres advisory lock (skip the workspace this tick rather than queue) is the chosen mechanism.
- R3. A global env kill switch (`FLEETGRAPH_SWEEP_ENABLED`, default off) gates whether the scheduler registers at all; per-workspace gating lives in `workspaces.settings->fleetgraph->>'sweep_enabled'` (default off).
- R4. Detection logic reuses `computeProjectDrift` and its thresholds (`IDLE_DAYS=7`, `STALE_PLAN_DAYS=21`, `RISING_WORK_MIN_DELTA=2`). The sweep must not invent its own thresholds — semantic parity with the on-read badge is part of the contract.
- R5. The sweep produces insights via the existing `createOrRefreshInsight` only — it never inserts directly. Insight identity is `(workspace_id, subject_id, kind)`; refreshes update `evidence`, `occurrence_count`, `last_seen_at`, and re-set state to `open` on FYI→ACT escalation (per PR #41).
- R6. `GET /api/insights` returns the workspace's insights, visibility-scoped against the *subject* (mirrors `listOpenInsights`). Supports `?state` (`open` | `resolved` | `all`, default `open`), `?kind`, `?limit`, `?offset` query params. (Substrate extension noted in U4; cursor pagination deferred — offset is what the substrate already supports.)
- R7. `GET /api/insights/:id` returns one insight, visibility-scoped against the subject. 404 when not visible.
- R8. `POST /api/insights/:id/resolve` resolves an insight idempotently (delegates to `resolveInsight({insightId, workspaceId, reason?})`); requires the resolver to have the same subject visibility as for reads. Substrate does NOT currently record `resolved_by`; v1 accepts that resolution is unattributed (deferred follow-up to extend substrate).
- R9. `POST /api/insights/sweep` triggers an immediate sweep of the caller's workspace. **Workspace-admin only.** Returns a delta summary (`{ scanned, created, refreshed, skipped }`). The trigger respects the same per-workspace advisory lock as the scheduled sweep — if another sweep is in flight, return 409.
- R10. `GET /api/workspaces/settings/fleetgraph` and `PATCH /api/workspaces/settings/fleetgraph` expose the per-workspace toggle. **Workspace-admin only** for PATCH; GET allowed to any workspace member.
- R11. A new "Insights" icon-rail mode renders a list of open insights for the workspace with a clickable detail view, a "Resolve" action on the detail, and a count badge on the rail icon when ≥1 open insight is visible to the user.
- R12. A `/settings/fleetgraph` page (workspace-admin only) shows the per-workspace toggle and a "Sweep now" button; both surface success/error state inline. Non-admins see a read-only banner explaining the toggle exists but they can't change it.
- R13. The shipped drift badge (`<DriftBadge>`) is unchanged. Insights and the badge coexist; both consume `computeProjectDrift`.

---

## Scope Boundaries

- Detection is **drift only** (`kind = 'project_drift'`). The substrate's other kinds (`stalled_issue`, `ownerless_issue`, etc., if any future) are not detected here.
- The substrate exposes `snoozed` and `dismissed` lifecycle states (per PR #41), but no code path in this plan produces them. The `?state` filter accepts only `open` | `resolved` | `all`; UI does not surface snoozed/dismissed.
- The sweep is **in-process** on the API. No separate worker process, no queue (e.g., bullmq, agenda).
- **No notification email / push / in-app toast.** Insights surface only on a viewed page (the Insights mode rail-count badge is the closest thing to a passive nudge).
- **No automated actions** taken from an insight (no auto-pinging owners, no auto-creating follow-up issues). Resolve is the only mutation.
- Snooze, dismiss, ask-FleetGraph-from-an-insight, and per-insight comments are out — the *exposed* lifecycle is `open → resolved` only (substrate still supports the others; no UI path reaches them).
- The shipped on-read drift badge is **not retired** in this plan.
- The scheduler runs on every API instance; per-workspace lock ensures correctness, but there's no leader-election layer (e.g., dedicated cron-only instance). Acceptable for current scale.

### Deferred to Follow-Up Work

- Severity-driven UI styling on the Insights list (color, sort priority). Initial UI sorts by `last_changed_at DESC`.
- Insight detail view "Ask Fleet about this insight" — wire to the existing `askFleetAbout*` helper used by `DriftBadge.tsx` once we have a verdict object to pass.
- Workspace-configurable thresholds (currently fixed in `computeProjectDrift`).
- Detection kinds beyond `project_drift`.
- Email / push / inbox-style notifications.

---

## Context & Research

### Relevant Code and Patterns

**Backend — sweep + scheduler**
- `api/src/services/fleetgraph/insight.ts` — shipped substrate (header lines 1-29 explain visibility-on-subject + JSONB write discipline; `createOrRefreshInsight` ~190, `resolveInsight` ~459, `listOpenInsights` ~553, `getInsight` ~633).
- `api/src/services/drift/computeProjectDrift.ts` — pure threshold function (`IDLE_DAYS=7`, `STALE_PLAN_DAYS=21`, `RISING_WORK_MIN_DELTA=2` at ~18-20). Reused verbatim.
- `api/src/routes/projects.ts` (`extractProjectFromRow` ~181-236, list CTE ~538-609, GET-single subqueries ~628-707) — already computes all the aggregates the sweep needs. The sweep's per-project pull can mirror this SQL shape, sourcing rows directly rather than going through HTTP.
- `api/src/index.ts:13-43` — API bootstrap. Cron registration hooks in here (after `server.listen`), not in `createApp()`, so unit tests that import the app don't spin a cron.
- `api/src/app.ts:188-250` — route mounting; new routes follow the same `app.use('/api/insights', conditionalCsrf, insightsRoutes)` pattern, with read-only routes mountable without `conditionalCsrf` (e.g., `/dashboard`, `/search`).

**Backend — advisory lock + JSONB writes**
- Advisory-lock precedent: `api/src/services/fleetgraph/insight.ts:195` (`pg_advisory_xact_lock(hashtextextended($1,0))`); the sweep introduces the first use of `pg_try_advisory_xact_lock` (non-blocking, returns boolean). No prior `pg_try_*` in the repo.
- JSONB write discipline: single-statement `jsonb_set(COALESCE(settings,'{}'), '{fleetgraph,sweep_enabled}', $1::jsonb, true)` — mirrors `insight.ts` ~338-378.

**Backend — REST + OpenAPI registration**
- `api/src/openapi/schemas/projects.ts` (~40-194) — canonical Zod + `registry.register` + `registry.registerPath` template.
- `api/src/openapi/schemas/index.ts:11-32` — barrel; new schema file MUST be added here for registration side-effects to fire.
- `api/src/routes/projects.ts:522-659` — canonical authenticated list endpoint that uses `VISIBILITY_FILTER_SQL` with the boolean shape.
- `api/src/middleware/auth.ts` — `authMiddleware` (~294), `assertAuthed` (~43-59), `workspaceAdminMiddleware` (~331-385).
- `api/src/middleware/visibility.ts` — `getVisibilityContext` (~26-32), `VISIBILITY_FILTER_SQL` (~65-81) boolean shape.

**Backend — workspaces table + settings**
- `api/src/db/schema.sql:6-13` — `workspaces` table; no `settings` JSONB column today. Migration 047 adds it.
- Last applied migration: `046_fleetgraph_insight_open_index.sql`. Next: `047`.

**Frontend — icon rail mode**
- `web/src/pages/App.tsx`: `Mode` type (~45); `getActiveMode` (~172-201); `handleModeClick` (~226-237); rail-icon entries (~384-414); sidebar dispatch (~518-565); `RailIcon` (~671).
- `web/src/main.tsx:223-256` — react-router routes; lazy-load the new Insights page mirroring ProjectsPage (~37, ~232).
- Closest mirror: Projects mode (rail icon, sidebar list, page).

**Frontend — settings page**
- `web/src/pages/WorkspaceSettings.tsx` — tabbed via `?tab=` URL param; mounted at `/settings` (`main.tsx:254`). Either extend with a `fleetgraph` tab or mount a separate `/settings/fleetgraph` route (precedent: `/settings/conversions` is its own page). Plan picks **separate page**: keeps the workspace-admin-only access check colocated and avoids muddling FleetGraph-specific UX with workspace administration.

**Frontend — data hooks + tests**
- `web/src/hooks/useProjectsQuery.ts` — TanStack Query template: hierarchical query keys, `useQuery` with `staleTime`, optimistic-update mutation pattern (~247-292).
- `web/src/components/DriftBadge.tsx` and `.test.tsx` — frontend test pattern; mirror for `InsightCard`, `InsightDetail`, etc.

**Tests — backend**
- `api/src/routes/projects.test.ts` — supertest with mocked `pool.query` and stubbed auth/visibility middleware. Template for `/api/insights` route tests.
- `api/src/services/fleetgraph/insight.test.ts` — service-level mocked-pool tests using `vi.hoisted()` for shared mocks.
- `api/src/services/fleetgraph/insight.concurrency.test.ts` — real-Postgres integration tests against `ship_test`. Template for sweep-concurrency / advisory-lock tests.
- `api/src/test/setup.ts:41-46` — suite-level TRUNCATE harness.

### Institutional Learnings

- `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md` — write the linkage in the same transaction as the parent row; assert reachability through the visibility-scoped read path, not just by primary key. Directly applicable: tests for the sweep must verify each persisted insight is reachable via `listOpenInsights` from the workspace, not just by `getInsightInternal` lookup.
- `docs/solutions/tooling-decisions/langsmith-two-tier-tracing-for-fleet.md` — applicable only if the sweep starts calling LLM-backed code (not in this plan, since `computeProjectDrift` is deterministic). Flagged as a future consideration if the sweep ever invokes raw-SDK paths.

### External References

- None. `node-cron` is a small, well-understood library; advisory-lock pattern is locally established; everything else is internal Express/`pg`/React mirroring existing patterns.

### Thin Local Grounding (worth knowing)

- **No prior in-process cron job exists** in the API. This plan introduces the convention.
- **No prior "iterate all workspaces" pattern.** Sweep introduces it.
- **No prior `pg_try_advisory_xact_lock` use.** Plan introduces the non-blocking variant.
- **No prior `settings` JSONB column on `workspaces`.** Plan introduces it.
- **No prior icon-rail mode addition documented.** Mirroring Projects mode is the de facto template.

---

## Key Technical Decisions

- **`node-cron` over alternatives.** `node-cron` is a small dep with cron-syntax scheduling and no broker requirement. Considered: BullMQ/agenda (requires Redis/MongoDB, overkill for an opt-in hourly job), `setInterval` (already in use for cache cleanup but lacks cron-syntax semantics and drifts under load). `node-cron` lives in-process, registers in `api/src/index.ts` after `server.listen`, and is gated by a global env flag so test environments and CI never start it.

- **Non-blocking per-workspace advisory lock.** The sweep uses `pg_try_advisory_xact_lock(hashtextextended('sweep:' || $1, 0))` per workspace. If another API instance holds the lock, **skip this workspace this tick** rather than queue — the next tick (≤ 1 hour later) will retry. Releases on transaction COMMIT. This is the first use of `pg_try_*` (non-blocking) in the codebase. Alternative: blocking `pg_advisory_xact_lock` (used elsewhere) would serialize ticks across instances — wasteful when the work is already idempotent and the next tick will do it anyway.

- **Two-layer gate: global env + per-workspace toggle.** Global `FLEETGRAPH_SWEEP_ENABLED` (default off) is an ops kill switch checked at scheduler registration (no DB roundtrip; if off, scheduler doesn't even register). Per-workspace `settings->fleetgraph->>'sweep_enabled'` (default off) is the user-controlled gate checked per workspace inside the tick. Mirrors the `FLEET_AI_PROVIDER` pattern (presence-gate at boot + per-route runtime check).

- **`workspaces.settings` is a single JSONB column, not a side table.** A side table buys nothing today (no rows to query, no per-tenant audit history, no normalized queries) and would force a JOIN on every settings read. JSONB is YAGNI-friendly: future settings (e.g., `fleetgraph.sweep_cadence`, `notifications.*`) add keys without migrations. Migration 047 adds `settings JSONB NOT NULL DEFAULT '{}'::jsonb`. Writes are single-statement `jsonb_set` (no read-modify-write blob churn). Trade-off: typed access is `properties->...->>'x'` not `settings.x`; acceptable given the small surface.

- **Sweep computes drift in-process from a project-scoped SQL query, not by calling the HTTP `/api/projects` route.** The detector pulls per-project aggregate columns directly (same shape `extractProjectFromRow` uses), feeds them into `computeProjectDrift`, and calls `createOrRefreshInsight` for `isDrifting === true`. HTTP self-calls are wasteful and would re-cross auth/visibility boundaries unnecessarily for a service-level worker. Code reuse comes via the **existing** `api/src/services/drift/driftSql.ts` helper (`driftIssueAggregates(alias)`, `driftPlanLastEditedAt(alias)`) that `projects.ts` already imports — `sweep.ts` imports the same. No new helper file.

- **Insight payload construction for the sweep.** `createOrRefreshInsight` requires `subjectEntityType`, `summary`, `recommendedAction`, `verdict`, `inputHash` in addition to the obvious fields. Sweep policy:
  - `subjectEntityType`: always `'project'` (drift only this kind in v1).
  - `summary`: deterministic template per signal-set, e.g. `"Project drift: idle 9d, plan stale 24d"` (compose from `drift.signals[].reason`).
  - `recommendedAction`: fixed string per signal-set with a single template like `"Review project status and update plan or close stale issues."` — sweep is not LLM-backed in v1.
  - `verdict`: a minimal system-authored verdict object `{ decision: 'act' | 'fyi', confidence: 1.0, rationale: <same as summary>, model: 'system/computeProjectDrift', generated_at: <iso> }` — distinct from LLM verdicts. `decision` mirrors severity (`act` for `critical`/`warning`, `fyi` for `info`).
  - `inputHash`: stable hash of `{kind, signalTypes sorted, lastMovementAtDay, planLastEditedAtDay, openNow, incompleteNow, incomplete7dAgo}` — day-rounded so a stable detection doesn't bump `last_changed_at` every tick. SHA-1 of canonical JSON is sufficient.

- **Insight identity assertion in sweep tests via the visibility-scoped read path.** Per `fleet-chat-created-issue-not-associated-with-project.md`, verify each persisted insight is reachable through `listInsights({ workspaceId, userId, isAdmin: true, state: 'open' })` after the sweep, not just by primary key. Catches association/visibility scoping regressions where the row exists but isn't discoverable.

- **Service-level sweep principal.** The sweep has no user session. The substrate writes `created_by = NULL` unconditionally for all insights (per PR #41 — no `createdBy` arg in `CreateOrRefreshInsightArgs`). The advisory lock + workspace scoping is the trust boundary.

- **Read endpoints extend the existing `listOpenInsights`/`getInsight` minimally** — the substrate today hardcodes `state='open'` and offers no state filter; this plan adds a `state?: InsightStatus | 'all'` option to `ListOpenInsightsOptions` (and renames the function to `listInsights` to match the now-broader behavior). Existing tests (`insight.test.ts`) update to assert the new signature; existing call sites pass `state: 'open'` explicitly or rely on the default to preserve behavior. `POST /resolve` similarly delegates to `resolveInsight({insightId, workspaceId, reason?})` — substrate is unchanged.

- **Manual sweep endpoint is workspace-admin only.** A non-admin shouldn't be able to compel a heavy workspace-wide scan. The toggle (R10 PATCH) is also admin-only for the same reason.

- **Icon-rail badge count.** The rail icon shows a count of open insights visible to the current user via a dedicated `GET /api/insights/count?state=open` endpoint that runs a lightweight `COUNT(*)` with the same visibility filter (avoids fetching rows or extending `listInsights` with a duplicate COUNT query). The Insights page fetches the full list separately.

- **Insights mode is always visible in the rail** (not feature-flag-hidden). When the workspace has no insights, the page renders an empty state explaining the sweep (with a link to settings for admins). Hiding the mode based on the toggle would create discoverability dead-ends.

---

## Open Questions

### Resolved During Planning

- **Cron cadence:** hourly (`0 * * * *`). Faster cadences buy nothing for drift signals on day-week thresholds.
- **Manual sweep concurrency vs. scheduled sweep:** same advisory lock. `sweepWorkspaceDrift()` (called without a client) throws `SweepInProgressError` on `pg_try_advisory_xact_lock=false`; route catches and maps to 409. Mirrors `InsightStateRaceError` precedent in `insight.ts:513-516`.
- **List pagination:** offset/limit (matches the substrate's existing shape). Cursor pagination deferred.
- **List sort order:** preserve the substrate's existing order (`(severity='act') DESC, last_seen_at DESC, id DESC`). UI does not re-sort.
- **`settings` column scope:** single `settings JSONB` with namespaced keys (`fleetgraph.*`, future `notifications.*`). Not `fleetgraph_settings`-specific.
- **Settings page placement:** separate `/settings/fleetgraph` route, not a tab in `WorkspaceSettings`. Keeps admin-only checks colocated and matches the `/settings/conversions` precedent.

### Deferred to Implementation

- Exact SQL shape of the sweep's per-project pull (single CTE vs. join shape). The `projects.ts` queries are the reference; pick whichever produces the same aggregate set with the simplest plan against the live data shape.
- Whether the sweep should batch `createOrRefreshInsight` calls (one tx per project today; could combine into one big tx per workspace if perf bites). Default: one tx per project (lock contention is per-subject, lower coupling, easier to reason about).
- Concrete OpenAPI response example structure for the insight (the `evidence` object shape was settled in PR #41 but the doc-shape example needs the actual subject fields). Settle while wiring the Zod schema in U4.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
API boot (api/src/index.ts)
   └─ if FLEETGRAPH_SWEEP_ENABLED → startScheduler()
                                          │
                                          ▼
                       node-cron "0 * * * *" → runFleetgraphSweepTick()
                                          │
                                          ▼
         SELECT id FROM workspaces
            WHERE archived_at IS NULL
              AND settings->'fleetgraph'->>'sweep_enabled' = 'true'
                                          │
                            for each workspaceId (serial):
                                          │
                                          ▼
            BEGIN
              SET LOCAL statement_timeout = '30s'
              IF pg_try_advisory_xact_lock(hashtextextended('sweep:'||ws, 0))
                 sweepWorkspaceDrift(ws, client)
                   ├─ pull project aggregates (mirrors projects.ts SELECT)
                   ├─ for each eligible project:
                   │     drift = computeProjectDrift(inputs, now)
                   │     if drift?.isDrifting → createOrRefreshInsight({
                   │         workspaceId: ws, subjectId: projectId,
                   │         kind: 'project_drift',
                   │         severity: signalsToSeverity(drift.signals),
                   │         evidence: { signals: drift.signals, computed_at, ... },
                   │         createdBy: null
                   │       })
                   └─ collect counts {scanned, created, refreshed, skipped}
            COMMIT  (releases advisory lock)


HTTP read path
   GET  /api/insights              → listInsights({ws, userId, isAdmin, state, kinds, limit, offset})
   GET  /api/insights/count        → countInsights({ws, userId, isAdmin, state}) → { count }
   GET  /api/insights/:id          → getInsight(id, {ws, userId, isAdmin})
   POST /api/insights/:id/resolve  → resolveInsight({insightId, workspaceId, reason?})
   POST /api/insights/sweep        → admin-only manual trigger of sweepWorkspaceDrift(ws)
                                       (service acquires its own client+lock; throws
                                        SweepInProgressError on contention → 409)

   GET   /api/workspaces/settings/fleetgraph   → read settings.fleetgraph
   PATCH /api/workspaces/settings/fleetgraph   → admin-only; jsonb_set on settings


Web
   Icon rail: 'insights' mode → /insights → InsightsPage
   InsightsPage (4-panel): mode header → InsightsSidebar (count, filter chips)
                         → InsightsList (cards) → InsightDetail (resolve action)
   /settings/fleetgraph (admin) → toggle + "Sweep now" button
```

---

## Output Structure

```
api/
  src/
    db/migrations/
      047_workspaces_settings_jsonb.sql       (new — U1)
    services/
      workspace-settings.ts                   (new — U1)
      workspace-settings.test.ts              (new — U1)
      fleetgraph/
        sweep.ts                              (new — U2; exports SweepInProgressError)
        sweep.test.ts                         (new — U2)
        sweep.concurrency.test.ts             (new — U2)
        insight.ts                            (modify — U4: rename listOpenInsights → listInsights, add state filter, add countInsights)
        insight.test.ts                       (modify — U4: update for new signature)
    scheduler/
      index.ts                                (new — U3)
      index.test.ts                           (new — U3)
    routes/
      insights.ts                             (new — U4)
      insights.test.ts                        (new — U4)
      workspaces.ts                           (modify — U4: settings GET/PATCH)
    openapi/schemas/
      insights.ts                             (new — U4)
      workspace-settings.ts                   (new — U4)
      index.ts                                (modify — U4: barrel re-export)
    app.ts                                    (modify — U4: mount /api/insights)
    index.ts                                  (modify — U3: startScheduler call)
    package.json                              (modify — U3: add node-cron ^4.0.0)

web/
  src/
    hooks/
      useInsightsQuery.ts                     (new — U5)
      useWorkspaceSettingsQuery.ts            (new — U6)
    pages/
      Insights.tsx                            (new — U5)
      FleetGraphSettings.tsx                  (new — U6)
      App.tsx                                 (modify — U5: 'insights' Mode wiring)
    components/
      insights/
        InsightCard.tsx                       (new — U5)
        InsightDetail.tsx                     (new — U5)
        InsightsSidebar.tsx                   (new — U5)
        InsightCard.test.tsx                  (new — U5)
        InsightDetail.test.tsx                (new — U5)
    main.tsx                                  (modify — U5: routes for /insights and /settings/fleetgraph)
```

---

## Implementation Units

### U1. Workspaces `settings` JSONB column + service

**Goal:** Add a per-workspace `settings` JSONB column and a small read/update service so future settings can land without further migrations.

**Requirements:** R3 (storage); R10 (storage substrate — endpoints in U4)

**Dependencies:** None

**Files:**
- Create: `api/src/db/migrations/047_workspaces_settings_jsonb.sql`
- Create: `api/src/services/workspace-settings.ts`
- Create: `api/src/services/workspace-settings.test.ts`

**Approach:**
- Migration adds `settings JSONB NOT NULL DEFAULT '{}'::jsonb` to `workspaces`. Idempotent: `ADD COLUMN IF NOT EXISTS`. No backfill needed — default covers existing rows.
- Service exposes:
  - `getWorkspaceSettings(workspaceId)` → returns `Record<string, any>` (the `settings` blob; callers narrow as needed).
  - `getFleetgraphSettings(workspaceId)` → `{ sweepEnabled: boolean }` (typed accessor; defaults `false` when key missing).
  - `setFleetgraphSweepEnabled(workspaceId, enabled)` → single-statement `UPDATE workspaces SET settings = jsonb_set(COALESCE(settings,'{}'), '{fleetgraph,sweep_enabled}', $1::jsonb, true) WHERE id = $2`. Returns updated value.
- All writes single-statement (no read-modify-write of the whole blob) — mirrors `insight.ts` JSONB write discipline.

**Patterns to follow:** `api/src/services/fleetgraph/insight.ts` JSONB write discipline (header ~22-26; `createOrRefreshInsight` refresh branch ~338-378). Migration shape: `api/src/db/migrations/046_fleetgraph_insight_open_index.sql`.

**Test scenarios:**
- Happy path — get on a fresh workspace returns `{}` / `{ sweepEnabled: false }`.
- Happy path — set enabled true, then get returns `{ sweepEnabled: true }`; underlying column is `{"fleetgraph": {"sweep_enabled": true}}`.
- Edge case — set on a workspace with pre-existing unrelated keys (`settings = {"foo": "bar"}`) preserves the unrelated keys (single-statement jsonb_set with `create_missing = true`).
- Edge case — set returns same value on idempotent double-call (no error, no state change visible to callers).
- Edge case — set on non-existent workspaceId returns null / does not throw.

**Verification:** Migration applies cleanly to a fresh DB and to a DB at migration 046; existing rows have `settings = '{}'`; service round-trips correctly.

---

### U2. Drift sweep detector

**Goal:** Pure-ish function that, given a workspace, detects all currently-drifting eligible projects and persists/refreshes their insights via the shipped substrate. Single tick of work; no scheduling, no env gates here.

**Requirements:** R1, R2 (single-flight discipline implemented here for the no-client call path; scheduler also wraps with its own lock per U3), R4, R5

**Dependencies:** U1 (settings shape — for `getFleetgraphSettings` pre-check optional), insight substrate (existing).

**Files:**
- Create: `api/src/services/fleetgraph/sweep.ts`
- Create: `api/src/services/fleetgraph/sweep.test.ts`
- Create: `api/src/services/fleetgraph/sweep.concurrency.test.ts`

**Approach:**
- Exports `sweepWorkspaceDrift(workspaceId: string, opts?: { client?: PoolClient }): Promise<SweepResult>` where `SweepResult = { workspaceId, scanned, created, refreshed, skipped }`.
- Exports `SweepInProgressError extends Error` (mirrors `InsightStateRaceError` in `insight.ts:513-516`). Thrown when the no-client path's `pg_try_advisory_xact_lock` returns false.
- `scanned` = eligible projects examined; `created` = `didCreate=true` from substrate; `refreshed` = `didCreate=false && insight !== null`; `skipped` = projects evaluated as non-drifting (or `insight=null` from the substrate's benign-race branch).
- Pull per-project aggregates by importing `driftIssueAggregates(alias)` and `driftPlanLastEditedAt(alias)` from the **existing** `api/src/services/drift/driftSql.ts` (which `projects.ts` already imports). No new helper file; same fragments. Query is scoped to one workspace's projects (`document_type='project'`, `archived_at IS NULL`, `deleted_at IS NULL`, `workspace_id=$1`).
- For each row, call `computeProjectDrift(inputs, now)`. If result is `null` or `!isDrifting`, increment `skipped`. Otherwise build the substrate arg bundle per the policy in Key Technical Decisions ("Insight payload construction for the sweep") and call `createOrRefreshInsight(args)`. Bucket the result into `created` vs `refreshed` via `didCreate`.
- **Single-flight contract:**
  - When called WITHOUT `opts.client`: acquire a client from the pool. `BEGIN; SET LOCAL statement_timeout = '30s'; SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))` keyed by `sweepWorkspaceLockKeyParams(workspaceId)`. If false → `ROLLBACK; release client; throw new SweepInProgressError()`. If true → run the per-project loop using that client's transaction; `COMMIT`; release. Catch ensures rollback + release on any error.
  - When called WITH `opts.client`: assume the caller already holds the transaction and the advisory lock for this workspace (the scheduler's case — U3 takes the lock around the call). Skip the lock probe and BEGIN/COMMIT; just run the per-project loop on the provided client.
- Export `sweepWorkspaceLockKeyParams(workspaceId): string` returning `'sweep:' + workspaceId` (single string for `hashtextextended`), mirroring `insightLockKeyParams` in `insight.ts:121-127`. The string namespace `sweep:` is disjoint from `insight.ts`'s `${workspaceId}:${subjectId}:${kind}` form (UUIDs never start with `sweep:`), so the two namespaces share the advisory-lock keyspace safely.

**Execution note:** Implement the pure aggregation + decision logic test-first against mocked rows; layer the real-Postgres concurrency test on after.

**Patterns to follow:**
- Aggregate SQL — mirror `projects.ts:538-609` (list CTE) and `:628-707` (single subqueries); both already pull these aggregates.
- `computeProjectDrift` — used as-is, do not duplicate thresholds.
- `createOrRefreshInsight` — call as-is; do not insert directly into `documents`.
- Lock-key helper shape — mirror `insightLockKeyParams` in `insight.ts:121-127`.

**Test scenarios (mocked-pool):**
- Happy path — workspace with 3 eligible projects: 2 drift (one idle, one stale_plan + rising), 1 healthy → `{scanned:3, created:2, refreshed:0, skipped:1}`; substrate called with full arg bundle (`subjectEntityType:'project'`, `summary` non-empty, `recommendedAction` non-empty, `verdict.decision`, `inputHash`).
- Refresh path — second call after first creates with identical inputs → substrate's `didCreate=false` for both, `{created:0, refreshed:2, skipped:1}`; `inputHash` stable (proves the no-op refresh branch is reachable).
- Eligibility — ineligible (`inferred_status='completed'`) projects are skipped before `computeProjectDrift` is even called.
- Empty workspace — zero eligible projects → `{scanned:0, created:0, refreshed:0, skipped:0}`; no substrate calls.
- Severity mapping — single signal → `info` (verdict.decision='fyi'); two → `warning` (verdict.decision='act'); three → `critical` (verdict.decision='act').
- `inputHash` stability — same inputs across two calls yield identical hash; changing `lastMovementAt` by one day shifts the hash (day-rounded), changing it by one minute does NOT.
- Summary template — reads "Project drift: " + comma-joined signal reasons.
- Lock-busy path (no client) — mock `pg_try_advisory_xact_lock` to return false → throws `SweepInProgressError`; no substrate calls; client released.
- With-client path — caller-supplied client is used as-is; no BEGIN/COMMIT or lock probe issued by the service (assertable via `pool.connect` and `client.query` mock-call shape).

**Test scenarios (real-Postgres, `sweep.concurrency.test.ts`):**
- Two parallel calls to `sweepWorkspaceDrift(ws)` (no client, on a workspace with one drifting project) → exactly one acquires the lock and returns the result; the other throws `SweepInProgressError`. One OPEN insight row in `documents`.
- Sequential calls — after the first creates, the second observes `refreshed:1` and the row's `occurrence_count` is 2.
- After the sweep, the persisted insight is reachable via `listInsights({workspaceId: ws, userId: <member>, isAdmin: true, state:'open'})` — guards the linkage/visibility lesson from `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md`.
- Sweep against a workspace with no projects completes cleanly with `scanned:0`.

**Verification:** Mocked-pool tests pass; concurrency suite passes; one `sweepWorkspaceDrift(ws)` call mid-workspace produces zero unexpected inserts (e.g., dup OPEN rows).

---

### U3. Scheduler with env kill switch + per-workspace `pg_try_advisory_xact_lock`

**Goal:** Hourly `node-cron` tick that iterates workspaces with the toggle on and calls `sweepWorkspaceDrift` under a non-blocking per-workspace advisory lock.

**Requirements:** R1, R2, R3

**Dependencies:** U1, U2

**Files:**
- Create: `api/src/scheduler/index.ts`
- Create: `api/src/scheduler/index.test.ts`
- Modify: `api/src/index.ts` (call `startScheduler()` after `server.listen`)
- Modify: `api/package.json` (add `node-cron` ^4.0.0 — ESM-compatible; the api package is `"type": "module"` so v3.x CJS-only releases will fail to import. No separate `@types/node-cron` is needed for v4 — types ship with the package.)

**Approach:**
- `startScheduler()` checks `process.env.FLEETGRAPH_SWEEP_ENABLED === 'true'` and returns silently if not. When enabled, registers `cron.schedule('0 * * * *', runFleetgraphSweepTick)` (hourly on the hour) and stores the task handle in a module-level variable. Schedule string is a named constant for testability.
- `stopScheduler()` (exported) calls `task?.stop()` on the module-level handle. Required for vitest cleanup (`afterEach` in `scheduler/index.test.ts`) — without it, the cron interval keeps the test process alive past suite end. Wiring into the process SIGTERM handler is out of v1 scope but the export exists for it.
- `runFleetgraphSweepTick()`:
  1. `SELECT id FROM workspaces WHERE archived_at IS NULL AND settings->'fleetgraph'->>'sweep_enabled' = 'true'` — only enabled workspaces touch the loop.
  2. For each `ws` (serial; not parallel — bounded blast radius, easier to reason about):
     - Acquire a client, `BEGIN; SET LOCAL statement_timeout = '30s'; SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0));` with the lock-key string from `sweepWorkspaceLockKeyParams(ws)`.
     - If the `pg_try_*` returns false, `ROLLBACK` and log "sweep skipped (lock held): ws=...". Release client. Move to next workspace.
     - Else call `sweepWorkspaceDrift(ws, { client })`; `COMMIT` (releases lock); release client; log result.
  3. Catch and log per-workspace errors so one workspace's failure doesn't abort the tick.
- Expose `runFleetgraphSweepTickOnce()` (same logic, no cron registration) so the tests can invoke a single tick. The manual-trigger endpoint (U4) instead calls `sweepWorkspaceDrift(ws)` directly (no client arg — service handles its own lock and throws `SweepInProgressError` on contention). Two callers, one service contract; only the scheduler wraps the lock externally because it needs to hold the lock across the iteration.

**Execution note:** Service-level mocked-pool tests for the iteration / lock-branch logic; real-Postgres test (in `sweep.concurrency.test.ts` from U2 or here) for actual `pg_try_advisory_xact_lock` behavior across two simultaneous tick invocations.

**Patterns to follow:**
- `setInterval` cache-cleaner registration sites for the "register at boot, hold module-level handle for shutdown" shape (`api/src/services/ai-analysis.ts:44`, `api/src/services/fleet-ai.ts:264`, `api/src/services/fleetgraph/rate-limit.ts:41`).
- Lock-helper key shape — `insightLockKeyParams` in `insight.ts:121-127`.

**Test scenarios (mocked-pool):**
- `FLEETGRAPH_SWEEP_ENABLED` unset / `'false'` → `startScheduler()` does not call `cron.schedule`; no DB queries.
- Enabled + zero enabled workspaces → tick runs one SELECT, no lock attempts, no `sweepWorkspaceDrift` calls.
- Enabled + 3 workspaces — all locks succeed → 3 `sweepWorkspaceDrift({client})` calls; result summary logged per workspace.
- Lock-busy on workspace 2 — `pg_try_advisory_xact_lock` returns false → no `sweepWorkspaceDrift` call for ws2; ws1 and ws3 still run.
- One workspace throws inside `sweepWorkspaceDrift` → error logged with workspace id; other workspaces still process; tick returns without re-throwing.
- Schedule cron string is `'0 * * * *'` (hourly) — assert the constant is passed to `cron.schedule`.
- `stopScheduler()` after `startScheduler()` cleanly stops the task (no leaked timers; `afterEach` of this file uses it).

**Test scenarios (real-Postgres):**
- Two concurrent `runFleetgraphSweepTickOnce()` calls against a DB with one enabled workspace → both run, exactly one acquires the lock and sweeps; the other observes `pg_try_*` false and skips.

**Verification:** Scheduler registers when enabled; serial workspace iteration logs each result; lock-busy workspaces are skipped; one failing workspace doesn't poison the tick.

---

### U4. REST endpoints: `/api/insights/*` + `/api/workspaces/settings/fleetgraph`

**Goal:** Authenticated, visibility-scoped endpoints that read/resolve insights, surface the toggle, and trigger manual sweeps. Also extends the shipped substrate's `listOpenInsights` minimally to support a `state` filter and adds a `countInsights` query.

**Requirements:** R2 (manual-trigger 409 path), R6, R7, R8, R9, R10

**Dependencies:** U1, U2, U3

**Files:**
- Create: `api/src/routes/insights.ts`
- Create: `api/src/routes/insights.test.ts`
- Create: `api/src/openapi/schemas/insights.ts`
- Create: `api/src/openapi/schemas/workspace-settings.ts`
- Modify: `api/src/openapi/schemas/index.ts` (barrel re-exports)
- Modify: `api/src/services/fleetgraph/insight.ts` (rename `listOpenInsights` → `listInsights`; add `state?: InsightStatus | 'all'` option with default `'open'`; add `countInsights(opts)` mirroring the visibility-filter shape but returning `{ count: number }`)
- Modify: `api/src/services/fleetgraph/insight.test.ts` (update for renamed function + state filter; assert default state='open' preserves existing behavior)
- Modify: `api/src/routes/workspaces.ts` (add settings/fleetgraph GET + PATCH handlers)
- Modify: `api/src/app.ts` (mount `app.use('/api/insights', conditionalCsrf, insightsRoutes)`)

**Approach:**

**Substrate extension (done in this unit before the routes are wired):**
- `listOpenInsights(opts: ListOpenInsightsOptions)` → renamed `listInsights(opts: ListInsightsOptions)`. `ListInsightsOptions` adds `state?: InsightStatus | 'all'` defaulting to `'open'`. SQL changes from hardcoded `... = 'open'` to:
  - When `state === 'all'`: drop the state predicate entirely.
  - When `state` is a single status: parameterize.
- `countInsights(opts: ListInsightsOptions): Promise<number>` — same query shape (same visibility filter, same join, same WHERE) but `SELECT COUNT(*)` and no limit/offset.
- All existing call sites pass `state: 'open'` explicitly (or rely on the default) so substrate behavior is preserved. `insight.test.ts` updates assert the new signature + state filter; concurrency-test reachability assertion in U2 already uses the renamed name.

**Routes:**
- **`GET /api/insights`** — Zod query `{ state?: 'open'|'resolved'|'all' (default 'open'), kind?: InsightKind, limit?: number (default 25, max 100), offset?: number (default 0) }`. Handler calls `listInsights({ workspaceId, userId, isAdmin, state, kinds: kind ? [kind] : undefined, limit, offset })`. Returns `{ items: FleetInsight[] }`.
- **`GET /api/insights/count`** — Zod query `{ state?: 'open'|'resolved'|'all' (default 'open'), kind?: InsightKind }`. Handler calls `countInsights({ workspaceId, userId, isAdmin, state, kinds })`. Returns `{ count: number }`. Drives the rail badge.
- **`GET /api/insights/:id`** — calls `getInsight(id, { workspaceId, userId, isAdmin })`; 404 when null/undefined.
- **`POST /api/insights/:id/resolve`** — Zod body `{ reason?: string }`. Visibility check: call `getInsight` first; 404 if not visible. Then call `resolveInsight({ insightId: id, workspaceId, reason })`. Returns `{ priorState, didResolve }` from the substrate. (Substrate does NOT record `resolvedBy` — accepted gap; flagged in Scope Boundaries / Deferred to Follow-Up Work for substrate extension.)
- **`POST /api/insights/sweep`** — `workspaceAdminMiddleware`-gated. Calls `sweepWorkspaceDrift(workspaceId)` (no client arg — service acquires its own client + advisory lock per U2). Catch `SweepInProgressError` → return 409 `{ error: 'sweep_in_progress' }`. Otherwise return `SweepResult` as 200.
- **`GET /api/workspaces/settings/fleetgraph`** — any workspace member; calls `getFleetgraphSettings(workspaceId)`; returns `{ sweepEnabled: boolean }`.
- **`PATCH /api/workspaces/settings/fleetgraph`** — `workspaceAdminMiddleware`-gated; Zod body `{ sweepEnabled: boolean }`; calls `setFleetgraphSweepEnabled(workspaceId, sweepEnabled)`; returns updated value.
- All Zod schemas registered via `registry.register(...)`; all paths via `registry.registerPath(...)`. Schema files re-exported through `openapi/schemas/index.ts` so the side-effect registration fires at import time.

**Patterns to follow:**
- Route-handler boilerplate: `api/src/routes/projects.ts:522-659`.
- OpenAPI schema + path registration: `api/src/openapi/schemas/projects.ts:40-194`.
- `assertAuthed` + `getVisibilityContext` boilerplate: `api/src/routes/projects.ts:538`.
- `workspaceAdminMiddleware` usage: search for existing call sites in `api/src/routes/*.ts`.

**Test scenarios:**
- Covers R6. GET `/api/insights` with mocked `listInsights` returning 3 rows → response `items.length=3`.
- Covers R6. GET `/api/insights?state=resolved` passes `state='resolved'` to `listInsights`; default omitted → `state='open'`.
- GET `/api/insights/count?state=open` → 200 + `{count: N}`; admin and non-admin counts differ when a private-subject insight exists.
- Covers R7. GET `/api/insights/:id` happy path → 200 + insight; not visible → 404; non-existent id → 404.
- Covers R8. POST `/api/insights/:id/resolve` happy path → 200 + `{priorState, didResolve:true}`; not visible → 404; already-resolved → 200 + `{priorState:'resolved', didResolve:false}` (idempotent).
- Covers R9. POST `/api/insights/sweep` as admin → 200 + `SweepResult`; as non-admin → 403; service throws `SweepInProgressError` → 409 with `{error:'sweep_in_progress'}`.
- Covers R10. GET settings as member → 200 + `{sweepEnabled}`; PATCH as admin → 200 + new value; PATCH as non-admin → 403.
- Edge case — GET `/api/insights?limit=200` clamped to 100; invalid `state` → 400.
- Edge case — visibility: a workspace-private subject's insight is filtered out of the list for a non-admin who doesn't own/share the subject; included for admin (assert via the substrate-level `insight.test.ts` update covering the new state filter combined with the existing visibility test).
- SQL-shape assertion — `pool.query.mock.calls` reflects the `VISIBILITY_FILTER_SQL` boolean shape (no `isAdmin` param appended).
- Substrate signature — `insight.test.ts` updated to cover `state` parameter (default `'open'` preserves prior behavior; `'resolved'` filters to resolved rows; `'all'` drops the predicate); `countInsights` returns the same count as `listInsights(...).length` when no limit is set.

**Verification:** All routes register in OpenAPI (verify against `/swagger`); supertest pass on the route file; visibility scoping reuses substrate (no re-implementation).

---

### U5. Web: Insights icon-rail mode + page + data hooks

**Goal:** Add the "Insights" mode to the icon rail, render a list+detail page with a resolve action, and expose the rail count badge.

**Requirements:** R11, R13 (badge coexistence — no changes to `DriftBadge`)

**Dependencies:** U4

**Files:**
- Create: `web/src/hooks/useInsightsQuery.ts`
- Create: `web/src/pages/Insights.tsx`
- Create: `web/src/components/insights/InsightCard.tsx`
- Create: `web/src/components/insights/InsightDetail.tsx`
- Create: `web/src/components/insights/InsightsSidebar.tsx`
- Create: `web/src/components/insights/InsightCard.test.tsx`
- Create: `web/src/components/insights/InsightDetail.test.tsx`
- Modify: `web/src/pages/App.tsx` (add `'insights'` to `Mode`, `getActiveMode`, `handleModeClick`, rail icon, sidebar dispatch)
- Modify: `web/src/main.tsx` (lazy-load + route `/insights`)

**Approach:**
- **Data:** `useInsightsQuery({state, kind, limit, offset})` mirrors `useProjectsQuery`. Query keys: `insightKeys.lists()`, `.list(filters)`, `.detail(id)`, `.count(filters)`. `useInsightQuery(id)` for the detail panel. `useInsightsCountQuery({state:'open'})` for the rail badge — calls `GET /api/insights/count` (small, cacheable). `useResolveInsightMutation()` is an optimistic-update mutation: `onMutate` flips the item to resolved in the list cache and snapshots; `onError` rolls back; `onSettled` invalidates `insightKeys.lists()` and `insightKeys.count(...)`. Mirror `useUpdateProject` in `useProjectsQuery.ts:247-292`.
- **Rail badge count:** `useInsightsCountQuery({state:'open'})` returns `{count}`; `<RailIcon>` for Insights displays it as a numeric pill on the icon corner when `count > 0`.
- **Insights mode wiring** (App.tsx):
  - `Mode` type — add `'insights'`.
  - `getActiveMode` — add `pathname.startsWith('/insights') ? 'insights' : ...`.
  - `handleModeClick` — `case 'insights': navigate('/insights');`.
  - `<RailIcon ... />` for Insights (after Projects, before Settings).
  - Sidebar header: `{activeMode === 'insights' && 'Insights'}`.
  - Sidebar body: `{activeMode === 'insights' && <InsightsSidebar ... />}`.
- **`InsightsSidebar`** — renders filter chips (state: open|resolved|all; kind: project_drift) and the count summary. Clicking a chip updates a URL query param consumed by `InsightsPage`.
- **`InsightsPage`** — main pane is a two-column split: left = `InsightCard` list (server-ordered: severity ACT first, then `last_seen_at DESC` — matches substrate order, no client re-sort), right = `InsightDetail` for selection.
- **`InsightCard`** — shows subject title (resolved from `evidence.subject_title` or fetched via `getInsight` for full enrichment), kind label, severity pill (mirror existing pill convention), reasons summary from `evidence.signals[].reason`, age (`last_changed_at` → "2h ago"). Accessibility: `<button>` (focusable, keyboard-actionable) with `aria-label` summarizing kind + subject + severity.
- **`InsightDetail`** — full evidence list, subject link (navigates to the project), and a "Resolve" button calling the resolve mutation with an optional note.

**Patterns to follow:**
- Mode addition mirror: Projects mode in `web/src/pages/App.tsx`.
- TanStack Query hook template: `web/src/hooks/useProjectsQuery.ts`.
- Optimistic mutation: `useUpdateProject` (`useProjectsQuery.ts:247-292`).
- Frontend test pattern: `web/src/components/DriftBadge.test.tsx`.

**Test scenarios:**
- Covers R11. `InsightCard` with a mock insight renders subject + kind + severity + age; `aria-label` contains all three.
- `InsightCard` clickable — calls `onSelect(insight.id)`.
- `InsightDetail` with a mock insight renders signals from `evidence.signals`; Resolve button triggers the mutation.
- Resolve mutation: optimistic update removes the item from the open list; rollback on error restores it.
- Empty state — list with `items=[]` renders an empty-state message + link to `/settings/fleetgraph` (link works for all; settings page itself gates write access).
- Rail badge — `count=0` → no badge; `count=5` → "5" pill (from `/api/insights/count`).
- Mode wiring — clicking the rail icon navigates to `/insights`; `getActiveMode` returns `'insights'` for `/insights/*` pathnames.

**Verification:** `pnpm dev` shows the rail icon; clicking it loads the page; resolving an insight removes it; refreshing the page shows the same state from the server.

---

### U6. Web: `/settings/fleetgraph` page (toggle + sweep-now)

**Goal:** Workspace-admin page to toggle the sweep on/off and trigger an immediate sweep.

**Requirements:** R12

**Dependencies:** U4

**Files:**
- Create: `web/src/hooks/useWorkspaceSettingsQuery.ts`
- Create: `web/src/pages/FleetGraphSettings.tsx`
- Create: `web/src/pages/FleetGraphSettings.test.tsx`
- Modify: `web/src/main.tsx` (add `/settings/fleetgraph` route)

**Approach:**
- `useWorkspaceSettingsQuery()` → `GET /api/workspaces/settings/fleetgraph` → `{ sweepEnabled }`.
- `useUpdateFleetgraphSettingsMutation()` → `PATCH /api/workspaces/settings/fleetgraph` with optimistic toggle update.
- `useSweepNowMutation()` → `POST /api/insights/sweep`; on success, invalidates `insightKeys.lists()` AND `insightKeys.count(...)` so the Insights mode + rail badge pick up new rows. On 409, surface "A sweep is already running — try again in a moment." Inline error states; no toast (consistent with the rest of the app).
- Page layout: a single section with two controls and an inline help paragraph. Renders a read-only banner for non-admin members ("Sweep settings are managed by workspace admins") instead of the toggle.
- Mounted as a top-level page at `/settings/fleetgraph`, not as a tab in `WorkspaceSettings`.

**Patterns to follow:**
- `web/src/pages/WorkspaceSettings.tsx` for the admin-gated settings-page shape (`useWorkspace().isWorkspaceAdmin` for in-component gating).
- `useProjectsQuery.ts` optimistic mutation for the toggle.

**Test scenarios:**
- Covers R12. Admin user sees the toggle; non-admin sees the read-only banner.
- Toggle ON → optimistic update flips UI; PATCH succeeds → toggle stays on; PATCH fails → toggle rolls back; error message inline.
- "Sweep now" → triggers `POST /api/insights/sweep`; success surfaces the delta (`X new, Y refreshed`); 409 surfaces the "already running" message.
- After sweep, `insightKeys.lists()` is invalidated (assert via TanStack QueryClient mock).

**Verification:** `/settings/fleetgraph` loads for admins, blocks non-admins; toggling persists; "Sweep now" round-trips and refreshes the Insights mode list.

---

## System-Wide Impact

- **New surfaces:** REST namespace `/api/insights/*` and two new settings sub-routes; new icon-rail mode; new settings page; new in-process scheduler.
- **Schema:** one new column (`workspaces.settings JSONB`) via migration 047. Idempotent + default; no backfill.
- **Concurrency model:** Sweep introduces the first use of `pg_try_advisory_xact_lock` and the first per-workspace iteration loop. Both are precedent-setting; document the pattern in `docs/solutions/` after landing (see Risks).
- **AuthZ:** `workspaceAdminMiddleware` is the gate for PATCH settings + manual sweep. Reads are visibility-scoped against the subject (substrate-handled). No new permission concepts.
- **Drift badge ↔ insight semantic parity:** both consume `computeProjectDrift`. If thresholds change in the future, both update together — but a project's badge can show "drifting" while no open insight exists if the sweep hasn't run since drift started (acceptable: badge is the live signal, insight is the persistent one).
- **Test surface:** add `node-cron` dep; vitest mocks for the scheduler; real-Postgres concurrency tests for the advisory-lock branches.
- **Unchanged invariants:** `<DriftBadge>`, `useProjectsQuery`, project routes, document types, collaboration server, all auth/visibility middleware semantics.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Multiple API instances run their own scheduler → double-fired sweeps. | Per-workspace `pg_try_advisory_xact_lock`; second instance skips this tick. Tested in `sweep.concurrency.test.ts`. |
| Sweep is slow at scale (many workspaces × many projects). | Per-workspace serial iteration with `SET LOCAL statement_timeout = '30s'`; aggregated SQL pulls all per-project inputs in one query per workspace. Add a real-Postgres benchmark test once we observe production cadence. |
| Schema migration runs into the migration-runner "already exists" bug observed during PR #41 (`api/src/db/migrate.ts` swallows errors). | Apply migration 047 with `ADD COLUMN IF NOT EXISTS` so re-runs are safe; verify in `schema_migrations` after deploy. The migrate.ts bug is out of scope but flagged in commit message. |
| Drift badge and insight surface diverge if sweep falls behind. | Acceptable known gap — badge is live, insight is persistent; documented in System-Wide Impact. Sweep cadence (1h) bounds the lag. |
| `node-cron` task continues running after a process gets SIGTERM mid-tick, blocking shutdown. | `stopScheduler()` exported and called from `afterEach` in tests; production SIGTERM wiring deferred (acceptable: EB rolls process replacement, current shutdown path in `api/src/db/client.ts:39-44` calls `process.exit(0)` which kills the timer anyway). |
| `node-cron` v3 is CJS-only; api package is ESM (`"type": "module"`). | Pin `node-cron` `^4.0.0` — ESM-compatible release. Verify after `pnpm add` that the dist's `package.json` includes an `"import"` exports key. |
| `pg_try_advisory_xact_lock` returns false too often if ticks overlap → workspace never sweeps. | Hourly cadence vs. expected sub-second tick — extreme overlap implies a different bug. Add a log line on every skip so we can observe. |
| Adding `node-cron` introduces a new dep with security/maintenance surface. | `node-cron` is widely used; pin to a major version; review release notes. Alternative: cron via `setInterval + computeNextHourBoundary()` — rejected as more code for less standard semantics. |
| Insight identity edge case — sweep refreshes a row that was resolved between ticks. | Substrate already handles: resolved rows are append-only; refresh inserts a fresh OPEN row if no OPEN exists for `(workspace, subject, kind)`. Tested in PR #41. |
| The "Insights" rail icon always-visible but empty in workspaces that never enable the sweep — confusing for non-admin members. | Empty-state copy explicitly mentions the sweep is opt-in; admins get a link to `/settings/fleetgraph`; non-admins see "no insights for this workspace". |

---

## Sources & References

- **Sibling plans:**
  - `docs/plans/2026-05-27-002-feat-fleetgraph-insight-entity-plan.md` (completed) — insight substrate this layer activates.
  - `docs/plans/2026-05-27-001-feat-project-drift-detection-plan.md` (completed) — drift badge + `computeProjectDrift` reused here.
- **Brainstorms:**
  - `docs/brainstorms/2026-05-27-project-drift-detection-requirements.md` — origin of the drift signal definitions reused here.
- **Code:**
  - `api/src/services/fleetgraph/insight.ts` — substrate.
  - `api/src/services/drift/computeProjectDrift.ts` — thresholds.
  - `api/src/routes/projects.ts` — aggregate SQL and visibility pattern templates.
  - `api/src/middleware/{auth,visibility}.ts` — auth + visibility helpers.
  - `web/src/pages/App.tsx` — icon rail and mode dispatch.
  - `web/src/hooks/useProjectsQuery.ts` — TanStack Query template.
  - `web/src/pages/WorkspaceSettings.tsx` — settings page template.
- **Learnings:**
  - `docs/solutions/logic-errors/fleet-chat-created-issue-not-associated-with-project.md` — assert reachability via the visibility-scoped read path in sweep tests.
