# Type Safety Audit — Peer Review

A second pass on `audit/type-safety/README.md`. Same repo, same scope, but focused on what the first audit missed, mis-counted, or under-prioritized.

## What the original audit got right

- **Strict mode gap on web.** `web/tsconfig.json:1-21` does not extend root and is missing `noUncheckedIndexedAccess` / `noImplicitReturns`. This is real and load-bearing.
- **Hot-spot files** in the production-source table are correct (admin, projects, weeks, yjsConverter, workspaces).
- **`as any` in production is essentially one occurrence** (`api/src/routes/issues.ts:155`). Confirmed.
- **`SqlParam` shared type** is a good concrete suggestion; `(string | boolean | null)[]` is already used in 8+ places (e.g. `api/src/routes/documents.ts:113`, `api/src/routes/programs.ts:86`), so the precedent exists.
- **Counting methodology** is reproducible. `count.sh` runs clean.

## What it missed

### 1. The `req.userId!` problem is 9× larger than reported

The audit says "14 in admin.ts" and frames it as an admin-route issue. Reality:

```
$ rg -n 'req\.userId!' api/src --type ts | wc -l
132
```

That's 132 non-null assertions on `req.userId` alone across 18+ route files (`api/src/routes/standups.ts`, `issues.ts`, `weeks.ts`, `documents.ts`, `projects.ts`, `comments.ts`, …). The audit's headline "Total non-null assertions: 82" is **wrong** — the regex `[A-Za-z0-9_\)\]]!(\.|\[|,)` misses `userId!;`, `userId!)`, and end-of-line, which is the dominant form (`const userId = req.userId!;`). Best estimate of actual non-null assertion count: 200+.

The audit acknowledges the regex is heuristic but states "actual total may be marginally higher" — the true delta is at least 2.5x.

### 2. Three contradictory definitions of the same domain enum

Schema drift is the highest-impact type-safety issue in the repo and goes unmentioned:

| Symbol | `shared/src/types/document.ts` | `api/src/openapi/schemas/issues.ts` | API runtime |
|---|---|---|---|
| `IssuePriority` | `'low' \| 'medium' \| 'high' \| 'urgent'` (4 values) | `['urgent','high','medium','low','none']` (5 values, includes `'none'`) | `z.enum([...,'none'])` at `api/src/routes/issues.ts:32` |
| `AccountabilityType` | 10 values (including `weekly_retro`, `changes_requested_plan`, `changes_requested_retro`) | 7 values (`api/src/openapi/schemas/issues.ts:46-54`) | matches OpenAPI |
| `ICEScore` (impact/confidence/ease) | `1 \| 2 \| 3 \| 4 \| 5` | `z.number().int().min(1).max(5)` | `z.number().min(1).max(10)` at `api/src/routes/documents.ts:72-74` |

The web UI relies on `'none'` (`web/src/components/sidebars/IssueSidebar.tsx:87`, `web/src/hooks/useIssuesQuery.ts:223`). If any code path imports `IssuePriority` from `@ship/shared`, a TS-valid build will reject runtime data the API accepts. The 1-10 vs 1-5 ICE drift is the worst: `PATCH /api/documents/:id` will silently accept an `impact: 9` that `PATCH /api/projects/:id` would reject.

### 3. The DB→TS boundary is entirely untyped

```
$ rg 'pool\.query|client\.query' api/src --type ts | wc -l
1000+
$ rg 'QueryResult<|query<' api/src --type ts | wc -l
0
```

Every one of ~700 production SQL calls returns `QueryResult<any>`. `result.rows[0].sprint_start_date` (`api/src/services/accountability.ts:68`, `api/src/routes/issues.ts:865`, etc.) is typed `any`, which is why `noUncheckedIndexedAccess` does not catch the unchecked `rows[0]` dereference. The audit's "extractIssueFromRow(row: any)" example is the symptom; the root cause is that `pg` is never given a row type generic.

Fix path: `pool.query<IssueRow>(...)` plus a thin `IssueRow` per query. This single change downgrades the `row: any` count without semantic risk because `pg` does not validate — it just types.

### 4. `ApiResponse<T>` shape kills narrowing on the web client

`web/src/lib/api.ts:5-12` defines:

```ts
interface ApiResponse<T> { success: boolean; data?: T; error?: {...} }
```

Because `success` is `boolean` (not `true`/`false` literal), `if (res.success && res.data)` cannot narrow `data` from `T | undefined` to `T`. The downstream consequence is non-null assertions:

- `web/src/pages/AdminDashboard.tsx:87` `res.data!.isSuperAdmin`
- `web/src/pages/AdminWorkspaceDetail.tsx:126` `res.data!.invite`
- `web/src/pages/AdminWorkspaceDetail.tsx:179` `res.data!.member`

Converting to a discriminated union (`{success:true; data:T} | {success:false; error:ApiError}`) — already defined that way in `shared/src/types/api.ts:1-7` (which **has** `data?` not as the discriminant either) — would eliminate this pattern. Note that `shared/src/types/api.ts` exists, exports a near-identical type, and is **not used** by `web/src/lib/api.ts`. Duplicated, drifted, untyped.

### 5. Web duplicates shared domain types — and the dupes are looser

`shared/src/types/document.ts:46-50` defines `IssueState` and `IssuePriority` as string-literal unions. The web side ignores them:

- `web/src/hooks/useIssuesQuery.ts:25-48` — `Issue.state: string`, `Issue.priority: string` (any string accepted)
- `web/src/components/UnifiedEditor.tsx:26-96` — re-declares `BaseDocument`, `WikiDocument`, `IssueDocument`, `ProjectDocument`, `SprintDocument`, `UnifiedDocument`. `IssueDocument.state: string`, `IssueDocument.priority: string`.
- `web/src/pages/PersonEditor.tsx:13-39` — re-declares `PersonDocument`, `SprintMetric`, `SprintInfo`, `SprintMetricsResponse`
- `web/src/pages/ReviewsPage.tsx:52,102,133` — re-declares `Week`, `ProgramGroup`, `WeeklyDoc`
- `web/src/pages/TeamMode.tsx:20,48`, `web/src/pages/PublicFeedback.tsx:6`, `web/src/pages/Dashboard.tsx:14`, `web/src/pages/TeamDirectory.tsx:12`, `web/src/pages/OrgChartPage.tsx:21` — more domain-type duplication

In all observed cases the web copy is **strictly looser** than the shared source (string vs union, optional vs required). The audit phase 2 mentions "reusable database row types" but does not call out that the canonical types already exist and are simply unused on the consumer side.

### 6. `UnifiedDocument` discriminated union is broken-by-design

`web/src/components/UnifiedEditor.tsx:96`:

```ts
export type UnifiedDocument = WikiDocument | IssueDocument | ProjectDocument | SprintDocument | BaseDocument;
```

`BaseDocument` is a structural supertype of every other member. Including it in the union means `document_type === 'issue'` cannot narrow `document` away from `BaseDocument`, so all the type-specific field accesses still need casts. That is exactly what happens at lines 215-222:

```ts
state: (document as IssueDocument).state,
priority: (document as IssueDocument).priority,
impact: (document as ProjectDocument).impact,
confidence: (document as ProjectDocument).confidence,
ease: (document as ProjectDocument).ease,
```

Three different "as" casts on the *same* `document` variable in the same object literal. A real discriminated union (drop `BaseDocument` from the union, switch on `document_type`) would prevent this.

### 7. Sensitive request bodies parsed without Zod

The audit doesn't surface this. The unvalidated `req.body` destructures on auth/admin/setup paths:

- `api/src/routes/auth.ts:19` — `const { email, password } = req.body;` (login)
- `api/src/routes/invites.ts:118` — `const { password, name } = req.body;` (invite accept)
- `api/src/routes/setup.ts:36` — `const { email, password, name } = req.body;` (first-time setup)
- `api/src/routes/admin.ts:58,168,448,902,1128,1254` — workspace create, super-admin toggle, member add, role change
- `api/src/routes/workspaces.ts:327,427,739` — member role, invite create
- `api/src/routes/admin-credentials.ts:468` — `issuer_url, client_id, client_secret` (CAIA OIDC credentials)
- `api/src/routes/team.ts:466,651`, `api/src/routes/ai.ts:25,50`, `api/src/routes/documents.ts:435`, `api/src/routes/weeks.ts:2846,2975,3068`

15 route files (`api/src/routes/`) import Zod; 12 do not. Endpoints that *do* validate input use Zod via `safeParse(req.body)`. The unvalidated set is biased toward auth and admin — exactly where loose typing has the most blast radius.

### 8. Yjs / TipTap content has no `JSONContent` typing on the API side

`web/` correctly imports `JSONContent` from `@tiptap/react` (e.g. `web/src/components/Editor.tsx:3`). `api/src/utils/yjsConverter.ts` exposes the same shape as `any` / `any[]` and `api/src/routes/documents.ts:44,53` declares `content: z.any()` for create/update. JSONB content crossing the boundary loses every guarantee that the editor library provides. The audit names this file but does not flag that the TipTap type is already in the dependency tree and could be reused symmetrically.

### 9. `as unknown as` casts that lie about runtime values

Two occurrences in production code lie about types:

- `api/src/routes/workspaces.ts:301,303` — `role: null as unknown as string` and `joinedAt: null as unknown as string`. The route returns `null` but tells callers it's a string. The web client's `WorkspaceMember.role: 'admin'|'member'|null` happens to be correct, but the API code is misleading.
- `api/src/routes/claude.ts:62` — `req.query as unknown as ClaudeContextRequest`. No runtime validation; `req.query` values can be arrays (`?x=a&x=b` → `string[]`), so the cast is unsound.

### 10. Dead/duplicated `declare global` augmentations

`api/src/routes/documents.ts:1515-1526` and `api/src/routes/backlinks.ts:157-168` both add `req.user?: { id, email, name, workspaceId }` to the global Express request. `req.user` is **never read** anywhere in the codebase (`rg 'req\.user\b' api/src` returns 0). These are dead augmentations that conflict with the real session info on `req.userId`/`req.workspaceId` in `api/src/middleware/auth.ts:7-17`. Remove both.

### 11. `process.env` is `string | undefined` everywhere, but treated as `string`

53 unique env vars accessed (`rg -o 'process\.env\.[A-Z_]+' api/src | sort -u | wc -l = 53`). No `NodeJS.ProcessEnv` augmentation declared. Several call sites depend on undefined-narrowing at use time (`api/src/services/caia.ts:151-160` does it correctly), but most do not (`api/src/index.ts:24-25`, `api/src/app.ts:44`, `api/src/services/secrets-manager.ts:25,35`). One typed `Env` module loaded once at startup (via Zod) would replace ~50 sites.

### 12. `interface ApiResponse<T>` is defined twice with drift

- `shared/src/types/api.ts:2-6` — `error?: ApiError` (with `code, message, details?`)
- `web/src/lib/api.ts:5-12` — `error?: { code; message }` (no `details`)

The web client never imports from shared. Two definitions, one consumer. The shared one is also non-discriminated (`success: boolean`, not `success: true | false` literals), so even fixing the duplication will not produce narrowing without the discriminated-union rewrite from finding #4.

### 13. WebSocket message handling parses JSON without validation

`api/src/collaboration/index.ts:815` — `const message = JSON.parse(data.toString());` then `if (message.type === 'ping')` with no schema. The Yjs sync path is fine (binary protocol). The events socket path is a JSON channel that should validate before dispatching.

### 14. Query-param casts on filter-heavy endpoints

The audit calls out `: any` and `as any` but not the 76 `as string` casts in production API code. Most are applied to `req.query` values (`api/src/routes/issues.ts:148,160,168,178,187`, `api/src/routes/weeks.ts:91,123,124`, `api/src/routes/standups.ts:178`). `req.query` values can legitimately be `string | string[] | ParsedQs | ParsedQs[] | undefined`, so the cast lies. With multi-value query strings the SQL parameter is an array, not a string — silent type-driven bug surface.

## What the original audit overstated or mis-prioritized

- **`as any` in vitest mocks (~150 occurrences) is framed as remediation phase 5.** It's correctly deferred but undersold as a payoff: production code can be tightened first, then tests will need fewer mocks because the things being mocked become typed. The Phase 5 dependency on Phases 2-4 is stronger than written.
- **"Production `as any` is 1 occurrence" implies clean production code.** It is technically correct, but `as unknown` (9), `as string` on `req.query` (76), and `: any` on row mappers (54 prod hits) carry the same risk profile. The headline conceals the issue.
- **`req.userId!` framing.** The audit calls this "Phase 3" with "introduce an authenticated request type." That's correct but understated — given 132 occurrences across nearly every route file, this is the single highest-volume fix in the repo. It should be Phase 1 of the actual code changes (after "improve the audit signal").
- **The "test files dominate" framing** for top violation-dense files (38, 32, 30 in tests) suggests tests are the problem. They aren't — they are downstream symptoms of untyped production seams. The current ordering of the top-5 production list (`admin.ts`, `projects.ts`, `yjsConverter.ts`, `weeks.ts`, `workspaces.ts`) is more actionable.

## Additional recommendations, ordered by impact

1. **Make the discriminated union real.** Rewrite `shared/src/types/api.ts` `ApiResponse<T>` as `{ success: true; data: T } | { success: false; error: ApiError }`, then have `web/src/lib/api.ts` import it instead of duplicating. Removes ~all `res.data!` patterns.

2. **Resolve the enum-drift triplet.** Reconcile `IssuePriority` (add `'none'` to shared or remove from API+UI), `AccountabilityType` (add 3 missing values to OpenAPI schema), `ICEScore` (fix `api/src/routes/documents.ts:72-74` to 1-5). These are runtime correctness bugs, not just type smells.

3. **Type the `pg` boundary.** Introduce per-route `Row` interfaces and call `pool.query<Row>(...)`. Pair with `noUncheckedIndexedAccess` so `rows[0]` becomes `Row | undefined` instead of `any`. This is a mechanical pass that eliminates the `extractFooFromRow(row: any)` pattern and lets the existing strict-mode flags do their job.

4. **Define `AuthedRequest`.** Either as a route-level type (`type AuthedRequest = Request & { userId: string; workspaceId: string }`) or by changing the global augmentation in `api/src/middleware/auth.ts:9-15` to non-optional after middleware runs (typed middleware that narrows). Removes ~132 `userId!` sites in one pass.

5. **Web extends root tsconfig.** Add `"extends": "../tsconfig.json"` to `web/tsconfig.json` and remove redundant `strict: true`. Inherits `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Expect ~hundreds of new errors, fix incrementally.

6. **Generate web types from OpenAPI.** The registry at `api/src/openapi/registry.ts` already exists. Adding `openapi-typescript` (or similar) to web's build would replace every duplicated `interface Issue/Project/Standup` (~15 files listed in finding #5) with a single generated source.

7. **Validate all `req.body` on auth/admin endpoints.** The 12 unvalidated routes from finding #7 each need a Zod schema. Pre-existing schemas in `api/src/routes/issues.ts:29-79` and `api/src/routes/weeks.ts:1781-` show the team already knows the pattern.

8. **Add `exactOptionalPropertyTypes`.** With `[key: string]: unknown` index signatures on every `*Properties` type (e.g. `shared/src/types/document.ts:88`), `exactOptionalPropertyTypes` would catch real assignment-vs-omission bugs. Less impactful than 1-7 but cheap.

9. **Fix `UnifiedDocument` union** (`web/src/components/UnifiedEditor.tsx:96`) — drop `BaseDocument` from the union so `document_type`-based narrowing works. Then the casts at lines 215-222 collapse into a `switch(document.document_type)` block.

10. **Add `ProcessEnv` augmentation or a typed `env` module.** One `.d.ts` declaring `NodeJS.ProcessEnv` listing the 53 vars would type-check every `process.env.X` site without runtime change.

11. **Remove the dead `req.user` augmentations** in `api/src/routes/documents.ts:1515` and `api/src/routes/backlinks.ts:157`. They're never read and conflict with the canonical auth shape.

12. **Stop the `as unknown as string` lies** in `api/src/routes/workspaces.ts:301,303`. Either fix the response type to allow `null` (matches reality and matches the web type) or filter archived users out of the response.
