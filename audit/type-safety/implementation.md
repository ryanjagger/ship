# Type Safety — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-18), `peer-review.md` (independent second pass), and `baseline/summary.md` (type-aware ESLint counts, the authoritative numbers). Branch: `implement/type-safety`.

The work is structured into seven phases (see the plan section at the bottom). Each phase is independently shippable; later phases assume earlier ones have landed but do not strictly depend on them.

## Improvement target

Eliminate 25% of type-safety violations from the ESLint baseline. Baseline = 8,660 warnings → target ≤ 6,495. Every fix must preserve existing functionality and introduce correct, meaningful types that reflect the actual runtime data — replacing `any` with `unknown` without narrowing does not count.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| Lint baseline tooling | regex-based `count.sh` (under-counted non-null assertions ~2.5×) | type-aware `lint-report.mjs` is authoritative; `count.sh` marked deprecated | `e3a41e4`, `038addb` |
| Dead `req.user` global augmentations | declared in `api/src/routes/documents.ts:1518` and `api/src/routes/backlinks.ts:157`, conflicting with the real `req.userId` / `req.workspaceId` on auth middleware; zero readers | removed | `038addb` |
| `as unknown as string` lies in `api/src/routes/workspaces.ts:301,303` | API returned `null` for archived members' `role` and `joinedAt` but claimed `string` to callers; web client already typed it `string \| null` | local `WorkspaceMemberResponse` type with `role: 'admin' \| 'member' \| null` and `joinedAt: string \| null` | `038addb` |
| `req.query as unknown as ClaudeContextRequest` in `api/src/routes/claude.ts:62` | unsound cast (`?x=a&x=b` produces an array, not the asserted string), and the `context_type` runtime check ran after the cast had already claimed it was a string | `ClaudeContextQuerySchema.safeParse(req.query)` with the same union type; redundant manual check removed | `038addb` |
| Dynamic SQL parameter arrays | `any[]` (or ad-hoc `(string \| boolean \| null)[]`) | `SqlParam` type in `shared/src/types/db.ts`, applied as template in `api/src/routes/documents.ts` | `038addb` |
| `req.userId!` / `req.workspaceId!` non-null assertions (Phase 2) | 236 occurrences across 20 route files | zero in production code; replaced with `assertAuthed` / `assertUserAuthed` narrowing helpers that actually check at runtime | `15145e6` |
| Total warnings (baseline → Phase 1 → Phase 2) | 8,660 | 8,403 (−257) | — |

The Phase 1 reduction was small by design — these were the lowest-risk quick wins. Phase 2 delivered the −236 it predicted (one-for-one drop in `no-non-null-assertion`; non-null assertions don't cascade into `no-unsafe-*`, so the reduction is exactly the count of bangs removed). Phases 3 (discriminated `ApiResponse`) and 5 (typed `pg` boundary) are where the rest of the 25% target comes from.

## Implementation

### Phase 0 — Lint baseline tooling (already on the branch)

#### 1. Replace regex counts with type-aware ESLint

**Before.** `audit/type-safety/count.sh` used `ripgrep` regexes to count `any`, `as`, and `!` occurrences. The non-null assertion pattern `[A-Za-z0-9_\)\]]!(\.|\[|,)` missed the dominant form `const x = req.userId!;` (ends with `;`), under-counting by ~2.5× as the peer review proved. The script could not see downstream `no-unsafe-*` propagation at all — fixing one `any` at a boundary collapses dozens of `result.rows[0].foo` violations, and the regex script had no way to track that.

**Change.** Wired up flat-config ESLint with `typescript-eslint` (type-aware) at `eslint.config.mjs`. Added `audit/type-safety/lint-report.mjs` to run the rules across the monorepo and write per-rule, per-package, and top-files counts to `audit/type-safety/baseline/summary.md`. Root script: `pnpm lint:report`.

**After.** Authoritative counts. Baseline at branch-time:

```
Total warnings: 8660
  no-unsafe-member-access:   3907   no-non-null-assertion:    349
  no-unsafe-assignment:      2626   no-unsafe-call:           340
  no-unsafe-argument:         502   no-explicit-any:          269
```

**Commit.** `e3a41e4`

### Phase 1 — Quick wins

Six small, near-zero-risk fixes bundled into one PR. The aim was less about warning reduction (it was always going to be modest) and more about establishing patterns later phases reuse and eliminating outright lies in the type surface.

#### 1. Mark `count.sh` deprecated

**Before.** `audit/type-safety/README.md` "How violations were counted" pointed at `count.sh` as the reproduction script. Future contributors would have re-derived numbers from it.

**Change.** Added a deprecation banner above the existing description, pointing at `audit/type-safety/baseline/summary.md` and `lint-report.mjs`. Kept the script and the description in place so the history of the audit is preserved.

**After.** No one reads the wrong numbers by accident.

**Commit.** `038addb`

#### 2. Remove dead `req.user` global augmentations (peer-review §10)

**Before.** `api/src/routes/documents.ts:1518-1529` and `api/src/routes/backlinks.ts:157-168` both contained:

```ts
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string; workspaceId: string };
    }
  }
}
```

`req.user` is never read anywhere in `api/src` (verified with `rg 'req\.user\b' api/src` → zero hits). The canonical auth shape is `req.userId` / `req.workspaceId`, set by `api/src/middleware/auth.ts`. The dead augmentations created a contradictory parallel global type that any new code could accidentally consume.

**Change.** Deleted both blocks.

**After.** Single source of truth for the post-auth request shape. One less type lie waiting to mislead new code.

**Reproducibility.** `rg 'declare global' api/src` should no longer show `req.user` blocks; `rg 'req\.user\b' api/src` continues to return zero matches.

**Commit.** `038addb`

#### 3. Fix `as unknown as string` lies in `workspaces.ts` (peer-review §9)

**Before.** `api/src/routes/workspaces.ts:285-306` constructed the `GET /api/workspaces/:id/members` response by concatenating active members and archived members. For archived rows, the route returned `null` for `role` and `joinedAt` but cast both as `null as unknown as string`. The web client at `web/src/lib/api.ts:287-295` already typed `WorkspaceMember.role: 'admin' | 'member' | null` and `joinedAt: string | null` correctly, so the cast was lying to nobody useful — only to TypeScript.

**Change.** Introduced a local `WorkspaceMemberResponse` type with the honest shape and annotated both `.map(...)` callbacks with it. The cast disappears because the literal `null` matches the union directly:

```ts
type WorkspaceMemberResponse = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | null;
  personDocumentId: string | null;
  joinedAt: string | null;
  isArchived: boolean;
};

const members: WorkspaceMemberResponse[] = [
  ...activeResult.rows.map((row): WorkspaceMemberResponse => ({ ... })),
  ...archivedRows.map((row): WorkspaceMemberResponse => ({
    ...
    role: null,
    joinedAt: null,
    ...
  })),
];
```

**After.** API and web agree on the shape. No casts, no lies. (A follow-up could move `WorkspaceMemberResponse` into `shared/src/types/workspace.ts` so the web side imports it instead of redeclaring — deferred to Phase 6 with the broader web-duplicate-types cleanup.)

**Reproducibility.** `rg 'as unknown as string' api/src` returns zero matches in `workspaces.ts`.

**Commit.** `038addb`

#### 4. Validate `claude.ts` query params with Zod (peer-review §9)

**Before.** `api/src/routes/claude.ts:62` read query params via:

```ts
const { context_type, sprint_id, project_id } = req.query as unknown as ClaudeContextRequest;
```

The cast is unsound — `req.query` values are `string | string[] | ParsedQs | ParsedQs[] | undefined` (Express parses `?x=a&x=b` as an array), so the asserted shape can be wrong at runtime. The subsequent `if (!context_type)` and `default:` cases in the switch tried to defend at runtime, but the type system was already misleading any downstream code that touched `sprint_id` etc.

**Change.** Replaced the cast with a Zod schema and `safeParse`:

```ts
const ClaudeContextQuerySchema = z.object({
  context_type: z.enum(['standup', 'review', 'retro']),
  sprint_id: z.string().optional(),
  project_id: z.string().optional(),
});

const parsed = ClaudeContextQuerySchema.safeParse(req.query);
if (!parsed.success) {
  res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
  return;
}
const { context_type, sprint_id, project_id } = parsed.data;
```

Removed the now-redundant `if (!context_type)` check (Zod rejects undefined or invalid `context_type` before this line is reached). Left the existing per-branch `if (!sprint_id)` / `if (!project_id)` guards in place — these enforce context-specific requirements that Zod doesn't express here.

**After.** Multi-value query params (`?context_type=standup&context_type=review`) now produce a clean 400 instead of silently behaving as if a string had been passed. Downstream code receives correctly typed values.

**Reproducibility.** `curl 'http://localhost:3001/api/claude/context?context_type=standup&context_type=review'` returns 400 with the Zod error detail.

**Commit.** `038addb`

#### 5. Add `SqlParam` type, apply in `documents.ts` (peer-review §"got right")

**Before.** Dynamic SQL parameter arrays in route helpers were variously typed `any[]` (e.g. `api/src/routes/documents.ts:647`) or ad-hoc `(string | boolean | null)[]` (line 113 of the same file). The `any[]` form contaminated downstream `values.push(...)` calls; the ad-hoc form was correct but inconsistent and not reused.

**Change.** Added `shared/src/types/db.ts`:

```ts
export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Date
  | Buffer
  | string[]
  | number[];

export type SqlParams = SqlParam[];
```

Exported via `shared/src/types/index.ts`. Replaced both annotations in `api/src/routes/documents.ts`:

- line 113: `const params: (string | boolean | null)[]` → `const params: SqlParam[]`
- line 647: `const values: any[]` → `const values: SqlParam[]`

**After.** One shared type for the canonical `pg` parameter shape. `documents.ts` serves as the template for the Phase 5 pass that applies the same change across the rest of the routes.

**Reproducibility.** `pnpm --filter @ship/api type-check` is clean.

**Commit.** `038addb`

#### 6. (Deferred during execution) Import shared `IssueState` in web hooks

The user's quick-win list asked for "import `BelongsTo`, `IssueState`, etc. where web already partially uses shared". Attempted in `web/src/hooks/useIssuesQuery.ts` by tightening `Issue.state: string` → `Issue.state: IssueState`. The change cascaded into:

- `web/src/components/KanbanBoard.tsx` — declares its own duplicate `Issue` interface with `state: string` and `onUpdateIssue: (id, { state: string })`
- `web/src/pages/App.tsx:1067` — `handleChangeStatus(issue: Issue, state: string)`
- `web/src/components/IssuesList.tsx:656` — `handleUpdateIssue(id, updates: { state: string })`
- `web/src/hooks/useIssuesQuery.ts` `BulkUpdateRequest.updates.state: string`

That is the Phase 6 "web duplicates shared domain types" problem (peer-review §5), not a Phase 1 quick win. Adding the import as a marker without using it would be the kind of superficial change the improvement target rules out. Reverted; will land properly in Phase 6 alongside the duplicate-types cleanup. `IssuePriority` is additionally blocked on Phase 4 enum reconciliation (shared union is missing `'none'`).

### Verification (Phase 1)

- `pnpm --filter @ship/api test` — 28 files / 451 tests, all passing
- `pnpm --filter @ship/web test` — 16 files / 151 tests, all passing
- `pnpm --recursive type-check` — clean
- `pnpm lint:report` — 8,660 → 8,640 (−20). Updates written to `audit/type-safety/baseline/summary.md`.

### Phase 2 — `AuthedRequest` narrowing helpers (peer-review §1)

Highest reduction-per-LoC change in the codebase. The peer review counted 132 `req.userId!` and the actual sweep found 236 bangs total: 132 `req.userId!` plus 104 `req.workspaceId!` spread across 20 route files. Every authenticated handler was opening with the same pattern:

```ts
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.workspaceId!;
    // ...
```

The bangs lie type-side and provide zero runtime safety. If `authMiddleware` were ever misconfigured for a route, the bang would just hand undefined to the SQL driver and explode obscurely a few lines later.

#### Design decision

Three approaches were considered (notes in the original plan):

1. **Typed handler wrapper** — `authedHandler((req: AuthedRequest, res) => …)`. Explicit, but wraps every route in an extra function call and rewrites the registration signature.
2. **Non-optional global augmentation** — change `req.userId?` to `req.userId` in the global Express type. Smallest call-site change, but the type then lies on routes where `authMiddleware` is *not* applied.
3. **`asserts` narrowing helpers** *(chosen)* — `assertAuthed(req): asserts req is AuthedRequest` plus a userId-only variant. Add one line at the top of each handler, then drop the `!` from `req.userId` / `req.workspaceId`. TS narrows in place; existing references work unchanged.

Option 3 wins on three axes: real runtime check (the assertion *throws* with a clear message if the contract is violated, instead of silently propagating `undefined`), minimal call-site disturbance (no destructuring, no wrapping), and honest types (the global aug stays optional, which matches reality for unauthenticated routes).

#### Implementation

**Helpers** in `api/src/middleware/auth.ts`:

```ts
export type AuthedUserRequest = Request & { userId: string };
export type AuthedRequest = Request & { userId: string; workspaceId: string };

export function assertAuthed(req: Request): asserts req is AuthedRequest {
  if (!req.userId || !req.workspaceId) {
    throw new Error('assertAuthed: request is missing userId or workspaceId — ' +
                    'authMiddleware must run first and a workspace must be selected');
  }
}

export function assertUserAuthed(req: Request): asserts req is AuthedUserRequest {
  if (!req.userId) {
    throw new Error('assertUserAuthed: request is missing userId — authMiddleware must run first');
  }
}
```

**Per-file pass** across 21 route files:

| File | userId! removed | workspaceId! removed | Assertion added |
| --- | ---: | ---: | --- |
| `admin.ts` | 13 | 0 | none needed (consumers accept `string \| undefined`) |
| `workspaces.ts` | 8 | 0 | none needed |
| `auth.ts` | 2 | 0 | none needed |
| `api-tokens.ts` | 2 | 0 | none needed |
| `admin-credentials.ts` | 6 | 0 | none needed |
| `activity.ts` | 0 | 1 | none needed |
| `comments.ts` | 3 | 4 | none needed |
| `weeks.ts` | 24 | 24 | `assertAuthed` × 24 handlers |
| `issues.ts` | 19 | 15 | `assertAuthed` × 15 |
| `projects.ts` | 13 | 13 | `assertAuthed` × 14 |
| `team.ts` | 12 | 13 | `assertAuthed` × 13 |
| `programs.ts` | 9 | 9 | `assertAuthed` × 10 |
| `documents.ts` | 2 | 1 | `assertAuthed` × 10 |
| `weekly-plans.ts` | 2 | 9 | `assertAuthed` × 9 (incl. nested `weeklyRetrosRouter`) |
| `standups.ts` | 5 | 5 | `assertAuthed` × 5 |
| `dashboard.ts` | 3 | 3 | `assertAuthed` × 3 |
| `iterations.ts` | 2 | 2 | `assertAuthed` × 2 |
| `backlinks.ts` | 2 | 2 | `assertAuthed` × 2 |
| `search.ts` | 2 | 2 | `assertAuthed` × 2 |
| `ai.ts` | 2 | 0 | `assertAuthed` × 2 |
| `accountability.ts` | 1 | 1 | `assertAuthed` × 1 |

Seven files (the "none needed" rows) compiled clean after just dropping the bangs because their consumers already accepted `string | undefined` — notably `logAuditEvent({ actorUserId: string | null | undefined })`. The bangs in those files were superfluous; removing them was still a Phase 2 win because each removal eliminates one `no-non-null-assertion` warning.

For the remaining 14 files, TypeScript demanded narrowing somewhere in each handler. The mechanical pattern: insert `assertAuthed(req);` as the first statement inside every top-level `try {` (which in this codebase corresponds 1:1 with route handlers).

**Test mocks** — five test files mock `../middleware/auth.js`:

```ts
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => {
    req.userId = 'user-123';
    req.workspaceId = 'ws-123';
    next();
  }),
}));
```

These needed `assertAuthed: vi.fn()` and `assertUserAuthed: vi.fn()` added to the mock object, otherwise the route's call to `assertAuthed(req)` resolved to `undefined` and threw `TypeError: assertAuthed is not a function`. The mocks are intentionally no-op `vi.fn()` because the test fixtures already set `req.userId` / `req.workspaceId` directly, so the runtime assertion check is unnecessary in tests.

#### After

- `req.userId!` / `req.workspaceId!` count in production code: **0** (was 236).
- `no-non-null-assertion` warnings: 349 → 113 (−236, exactly the bangs removed; the rule has no downstream cascade).
- Where `authMiddleware` is misconfigured or skipped, the route now fails fast with `Error: assertAuthed: request is missing userId or workspaceId …` instead of silently passing `undefined` to SQL.

#### Reproducibility

```bash
rg 'req\.(userId|workspaceId)!' api/src      # only the comment in middleware/auth.ts
pnpm --filter @ship/api type-check           # clean
pnpm --filter @ship/api test                 # 451/451
pnpm --filter @ship/web test                 # 151/151
pnpm lint:report                             # Total: 8,403 (-237 from Phase 1, includes -1 from eslint 9 downgrade)
```

#### Notes for later phases

The 113 remaining `no-non-null-assertion` warnings are unrelated to auth. The top concentrations are `api/src/db/seed.ts` (35, dev-only data seeding) and various `arr[0]!` patterns guarding against `noUncheckedIndexedAccess`. Phase 5 (typed `pg` boundary) will collapse most of the array-index ones by making row types explicit; the seed file is a separate cleanup.

**Commit.** `15145e6`

## Plan (Phases 3–7)

Ordered by leverage (warning reduction per unit of work) ÷ risk. Each numbered item is one PR unless noted.

### Phase 3 — Discriminated `ApiResponse<T>` (peer-review §4, §12)

Two definitions exist and have drifted: `shared/src/types/api.ts` and `web/src/lib/api.ts`. Both use `success: boolean`, which means `if (res.success && res.data)` can't narrow `data` from `T | undefined` to `T`. Consumers compensate with `res.data!` (e.g. `web/src/pages/AdminWorkspaceDetail.tsx:126,179`).

1. Rewrite `shared/src/types/api.ts`:
   ```ts
   export type ApiResponse<T> =
     | { success: true; data: T }
     | { success: false; error: ApiError };
   ```
2. Delete the duplicate in `web/src/lib/api.ts`; import the shared type.
3. Update call sites to use `if (res.success)` narrowing; drop `res.data!`.

Expected reduction: 100–200.

### Phase 4 — Enum drift (peer-review §2)

Three runtime-correctness bugs disguised as type smells. Small in warning count, large in actual bug-fix value.

1. `IssuePriority`: add `'none'` to `shared/src/types/document.ts:50` (web UI already depends on it).
2. `AccountabilityType`: add the 3 values from shared missing in `api/src/openapi/schemas/issues.ts:46-54`.
3. `ICEScore`: fix `api/src/routes/documents.ts:72-74` from `min(1).max(10)` to `min(1).max(5)` so it matches `api/src/routes/projects.ts` and the shared `1 | 2 | 3 | 4 | 5` type.
4. Make shared the single source for all three.

Expected reduction: ~10 warnings. Worth doing for correctness.

### Phase 5 — Typed `pg` boundary (peer-review §3)

This is where the warning numbers actually move. Every one of ~700 production SQL calls returns `QueryResult<any>` today, which is the root cause of the 3,907 `no-unsafe-member-access` and 2,626 `no-unsafe-assignment` warnings. One PR per route file, in order:

| Route | Current warnings | Notes |
| --- | ---: | --- |
| `api/src/routes/weeks.ts` | 597 | `WeekRow`, `WeeklyPlanRow` |
| `api/src/routes/projects.ts` | 416 | `ProjectRow`, replace `extractProjectFromRow(row: any)` |
| `api/src/routes/team.ts` | 395 | `PersonRow`, `MembershipRow` |
| `api/src/routes/documents.ts` | 347 | `DocumentRow`; also tighten `content: z.any()` → `JSONContent` from `@tiptap/core` |
| `api/src/routes/issues.ts` | 299 | `IssueRow`, `IssueHistoryRow` |

`pg` doesn't validate at runtime — `pool.query<IssueRow>(…)` only types `result.rows`. So this is purely a type-level change with no runtime risk, provided the `Row` interface matches the `SELECT` columns. Discipline: when you change the SELECT, change the Row.

Expected reduction across the top three files alone: ~1,500. That plus Phases 1–3 hits the 25% target.

### Phase 6 — Web duplicate types + `UnifiedDocument` (peer-review §5, §6)

1. Replace duplicate `Issue`/`Project`/`Sprint`/`Week` interfaces in `web/src/components/UnifiedEditor.tsx`, `web/src/hooks/useIssuesQuery.ts`, `web/src/pages/PersonEditor.tsx`, `web/src/pages/ReviewsPage.tsx`, etc. with imports from `@ship/shared`.
2. Drop `BaseDocument` from the `UnifiedDocument` union (`web/src/components/UnifiedEditor.tsx:96`) so `document_type`-based narrowing actually works. Replace the `(document as IssueDocument).x` casts with a `switch(document.document_type)` block.
3. Unblocks the deferred Phase 1 sub-task (use shared `IssueState` in `useIssuesQuery.ts`).

### Phase 7 — Validate unvalidated `req.body` on auth/admin routes (peer-review §7)

12 route files take `req.body` directly without Zod validation, biased toward auth and admin (`auth.ts:19`, `invites.ts:118`, `setup.ts:36`, `admin.ts:58,168,448,902,1128,1254`, `workspaces.ts:327,427,739`, `admin-credentials.ts:468`, etc.). The team already knows the pattern — existing schemas in `api/src/routes/issues.ts:29-79` are the template. Correctness focus, not warning reduction.

### Phase 8+ (further if time permits)

- `web/tsconfig.json` extends root so it inherits `noUncheckedIndexedAccess` / `noImplicitReturns`. Will *increase* warnings short-term; defer.
- Generate web types from OpenAPI via `openapi-typescript`; kills the duplicate-type problem at its source.
- Test-file `as any` cleanup (~150 occurrences in vitest mocks). Cheap once production seams are typed because the things being mocked are now typed.
- `process.env` augmentation or typed `env` module (peer-review §11).
- WebSocket JSON message validation at `api/src/collaboration/index.ts:815` (peer-review §13).
- `req.query as string` casts on filter-heavy endpoints (peer-review §14).

## Branch state at time of writing

- **7 commits** on `implement/type-safety` so far:
  - `e3a41e4` — lint baseline tooling (Phase 0)
  - `038addb` — Phase 1 quick wins
  - `264a929` — Phase 1 doc backfill
  - `521c41c` — Phase 0 follow-up: drop reliance on `import.meta.dirname` (Node 20.11+) so lint runs on every Node version `package.json#engines` accepts
  - `15145e6` — Phase 2 `AuthedRequest` narrowing helpers
  - `f2d31ee` — Phase 2 doc backfill
  - `d9086ad` — Phase 0 follow-up: downgrade eslint to ^9 so the install/lint contract matches the declared Node 20.0+ range (eslint 10 required Node 20.19+)
- Phases 3–7 are planned but not implemented
