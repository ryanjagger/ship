---
title: "feat: AI-grouped \"Related\" view on the Issues page (FleetGraph related mode)"
type: feat
status: completed
date: 2026-05-29
origin: (none — solo plan, builds on docs/plans/2026-05-25-002-feat-fleetgraph-shared-agentic-graph-plan.md and the shipped dedup-on-create use case; see docs/fleetgraph/notes.md item 3)
---

# feat: AI-grouped "Related" view on the Issues page

## Summary

Add a third view mode to the global Issues page (`web/src/pages/Issues.tsx`), alongside List and
Kanban: **Related**, which groups the workspace's open issues by theme using an LLM. It is the
*clustering generalization* of the shipped dedup-on-create feature — where `dedup` judges ONE draft
title against a few pg_trgm candidates, the new `related` FleetGraph mode takes the WHOLE open-issue
set (server-fetched, visibility-scoped, with truncated descriptions) and asks the model which issues
are about the same underlying work, returning theme groups + an "Ungrouped" bucket. Read-only,
ephemeral (no persistence, no new table, no migration), provider-gated, rate-limited, and degrades to
the flat list when the model is unavailable.

The view runs **automatically when opened** (per product decision), so cost is bounded by: a recency
cap (N=120 most-recently-updated open issues), a per-issue body cap, a raised output token budget, an
in-memory server-side cache keyed on the visibility-scoped issue-set fingerprint, and a generous
react-query `staleTime` on the client.

---

## Problem Frame

The Issues page lists every issue flat. Related work is scattered — duplicates, issues touching the
same feature/component, issues stemming from one underlying problem — and nothing surfaces those
relationships. FleetGraph already reasons about issue relatedness (`dedup` mode) but only pairwise on
issue creation. `docs/fleetgraph/presearch.md` frames the intended pattern ("cheap detectors gate the
expensive model call"); `docs/fleetgraph/notes.md` item 3 anticipates issue dedup/grouping. The
primitives all exist (`evaluateStructured`, the single compiled graph, the route/gating/availability
scaffolding, the pluggable `ViewMode` system) — this plan composes them into a grouping view.

---

## Product decisions (from the requester)

1. **Grouping lens:** same theme / work area (not strict duplicates).
2. **Input signal:** titles + descriptions (bodies fetched server-side, capped).
3. **Trigger:** auto on view switch; cached after first run.
4. **Scope:** all visible open issues in the workspace (ignores the active filter tabs), recency-capped.

---

## Requirements

- R1. A new `related` FleetGraph mode clusters a seeded open-issue set by theme via `evaluateStructured`
  (same SDK path / zod-v3 Anthropic workaround as `dedup`/`drift`). Dispatched BEFORE the focal guard
  (it judges a list, not a focal entity).
- R2. The model references issues by 1-based index; the entry point maps indexes back to ids, drops
  out-of-range indexes, enforces ≥2 members per group, and lets each issue join at most one group.
- R3. The server fetches the whole visibility-scoped open-issue set itself (`fetchOpenIssuesForClustering`),
  capped to the N most-recently-updated open issues, each with a truncated plain-text body; `truncated`
  flags overflow.
- R4. New `GET /api/fleetgraph/related-groups` (read-only, no body): auth → provider gate (503) →
  visibility ctx → rate-limit (429) → `runRelatedGroups`. OpenAPI-registered.
- R5. Results are ephemeral (no persistence, no new document type/table). A per-process in-memory cache
  keyed on `(workspaceId, hash(issue-set id:updated_at))` absorbs the auto-trigger repeat cost (5-min TTL).
- R6. Any model failure / `FLEET_AI_PROVIDER=none` degrades to a candidates-only payload
  (`ai_available:false`); the client renders the flat issue list — never an error.
- R7. Frontend: a `related` `ViewMode` + toolbar toggle + render branch; `RelatedIssuesView` auto-runs
  the grouping via `useRelatedIssueGroups` (react-query, generous `staleTime`), gated behind
  `useFleetGraphAvailability` (the toggle is hidden when no provider is configured). Read-only v1.

## Scope boundaries / deferred

- No persistence (insight substrate + scheduler precompute) — the one-subject-per-insight identity
  model doesn't fit multi-issue clusters; revisit only if precompute/sharing is wanted.
- No embeddings/pgvector — the LLM clusters directly from text (boring-tech / YAGNI).
- No pg_trgm blocking prefilter beyond the recency cap.
- No per-group selection / bulk actions / keyboard nav (the flat `SelectableList` selection model).
- No prompt caching / Batch API. Alternative lenses (duplicates-only, root-cause) are prompt-swappable later.

---

## Key technical decisions

- **New graph mode over a direct `evaluateStructured` call**, to stay consistent with how `dedup`/`drift`
  judge lists and keep one Fleet surface (philosophy-aligned). The candidate set is seeded from OUTSIDE
  the graph (like dedup's candidates), so the focal `fetch` is never relied upon; `entityId` is a
  random UUID so `fetchFocal` finds nothing and `reasonRelated` (before the focal guard) still runs.
- **GET endpoint** (read-only, parameterless) so react-query caches it naturally.
- **In-memory cache** keyed on the visibility-scoped fingerprint — no leakage (a user only hits an entry
  for the exact set they can see), table-free (consistent with the fleet-ai rate limiters).
- **Cost bounding is first-class** given auto-trigger × whole-workspace × bodies: recency cap (N=120),
  per-issue body cap (~600 chars), `maxTokens: 4000`, server + client caching.

---

## High-level technical design

```
Issues page "Related" toggle ──auto──► GET /api/fleetgraph/related-groups
  (web)                                   auth → assertProviderAvailable(503) → ctx → rate-limit(429)
                                          ▼
                                runRelatedGroups(ctx)                       (services/fleetgraph/index.ts)
                                  1. fetchOpenIssuesForClustering(ctx,{limit:N})   (services/issue-dedup.ts)
                                     VISIBILITY_FILTER_SQL · open-only · +body(extractText, capped) · ORDER BY updated_at DESC · limit+1
                                  2. < 2 issues  → degraded (no model call)
                                  3. cache hit (workspace + issue-set fingerprint) → return cached
                                  4. graph.invoke({mode:'related', issueSet}, transient thread_id)
                                       scope → fetch(denied focal, ignored) → reasonRelated → output
                                         reasonRelated → evaluateStructured(RELATED_SYSTEM_PROMPT,
                                            buildRelatedUserContent, relatedGroupsSchema, maxTokens:4000)
                                  5. map 1-based member_indexes → ids (drop OOR; ≥2; one group/issue)
                                  6. cache + return
                                  ▼
                       FleetIssueGroupingResult { candidates, groups[], ungroupedIds, summary,
                                                  ai_available, analyzed_count, truncated }
  (web) ◄── react-query (staleTime 5m) ─┘  RelatedIssuesView: group headers + member rows + Ungrouped
                                           degrades to the flat list when ai_available:false / error / loading
```

---

## Implementation units (as shipped)

- **U1 Shared types** — `shared/src/types/fleet.ts`: `FleetIssueGroupCandidate`, `FleetIssueGroup`,
  `FleetIssueGroupingResult` (mirror the `FleetDedup*` block).
- **U2 Retrieval** — `api/src/services/issue-dedup.ts`: `fetchOpenIssuesForClustering` (+`DEFAULT_CLUSTER_LIMIT`),
  reusing `VISIBILITY_FILTER_SQL` + the open-issue filters + `extractText` body, `limit+1` for `truncated`.
- **U3 Clustering** — new `api/src/services/fleetgraph/related-config.ts` (schema + `RELATED_SYSTEM_PROMPT`
  + `buildRelatedUserContent`); `state.ts` (`related` mode + `issueSet` channel + `relatedReview` slot);
  `nodes/reason.ts` (`reasonRelated`, dispatched before the focal guard); `index.ts` (`runRelatedGroups`
  + in-memory cache + `__resetRelatedGroupsCacheForTests`).
- **U4 Endpoint + OpenAPI** — `routes/fleetgraph.ts` (`GET /related-groups`); `openapi/schemas/fleetgraph.ts`
  (schema + path registration).
- **U5 Frontend** — `useListFilters.ts` (`related` in the `ViewMode` union + localStorage allowlist);
  `DocumentListToolbar.tsx` (toggle button + `RelatedIcon`); `Issues.tsx` (availability-gated `viewModes`);
  `IssuesList.tsx` (render branch); new `hooks/useRelatedIssueGroups.ts` + `components/fleet/RelatedIssuesView.tsx`.
- **U6 Tests** — `services/fleetgraph/graph.test.ts` (5: group mapping, <2 short-circuit, OOR/singleton/one-group,
  degrade, cap+cache); `routes/fleetgraph.test.ts` (4: happy path, 503, 401, 429 + OpenAPI path); web
  `RelatedIssuesView.test.tsx` (5: loading, grouped, click, degraded, error).

---

## Templates cloned (no new patterns)

`runDedupReview` → `runRelatedGroups`; `dedup-config.ts` → `related-config.ts`; `POST /dedup-review`
→ `GET /related-groups`; `FleetDedup*` types → `FleetIssueGroup*`; `useSimilarIssues` → `useRelatedIssueGroups`;
`IssueDedupHint` → `RelatedIssuesView`; `ai-analysis.ts` body cap → clustering body cap.

---

## Verification

- `pnpm build:shared && pnpm type-check` — clean.
- `pnpm test` (api): 870 pass incl. 9 new (5 service + 4 route); web vitest: 243 pass incl. 5 new.
- Manual (browser, provider configured): switch to the **Related** view → auto-groups (flat list while
  loading) → groups with theme labels + reasons + Ungrouped bucket; re-open is cache-served; with
  `FLEET_AI_PROVIDER=none` the toggle is hidden; a mid-session provider error degrades to the flat list.

## System-wide impact / risks

- No schema change, no migration, no new table/document type — consistent with the unified-document model.
- Auto-trigger over the whole workspace is the heaviest path; mitigated by caps + dual-layer caching +
  the shared rate limiter. The in-memory cache is per-process (resets on restart) — acceptable for the
  single-instance deployment, matching the existing fleet-ai limiters.
