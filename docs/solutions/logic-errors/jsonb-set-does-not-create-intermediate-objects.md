---
title: jsonb_set with create_missing only creates LEAF keys, silently no-oping when intermediate objects don't exist
date: 2026-05-28
category: docs/solutions/logic-errors
module: workspace-settings
problem_type: logic_error
component: database
symptoms:
  - "UPDATE returns successfully but the JSONB column is unchanged"
  - "Setting a nested key on a fresh row (root='{}') is a silent no-op; same setter works after any sibling key exists"
  - "Mocked-pool unit tests pass (they assert SQL shape) but real-Postgres integration tests fail because the persisted value never changes"
  - "Caller's typed accessor reads back the default for a key it just 'wrote'"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [postgres, jsonb, jsonb-set, workspace-settings, fleetgraph, silent-bug, testing]
---

# jsonb_set with create_missing only creates LEAF keys, silently no-oping when intermediate objects don't exist

## Problem

`setFleetgraphSweepEnabled(workspaceId, true)` and `setFleetgraphLlmVerdictsEnabled(workspaceId, true)` in `api/src/services/workspace-settings.ts` both shipped using this pattern:

```sql
UPDATE workspaces
   SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{fleetgraph,sweep_enabled}',
         $1::jsonb,
         true                        -- create_missing
       )
 WHERE id = $2;
```

On a fresh workspace where `settings = '{}'`, the UPDATE returns successfully — but `settings` stays `'{}'` afterward. The PATCH endpoint returns 200, the caller's optimistic UI flip stays on, and the next `getFleetgraphSettings` read returns `{sweepEnabled: false, llmVerdictsEnabled: false}` because the JSONB column never actually changed.

## What Didn't Work

- **Adding more mocked-pool tests.** The existing test suite asserted SQL shape via `mockPoolQuery.mock.calls[0]` — every assertion passed because the SQL literally did contain `jsonb_set(...)`, `COALESCE(...)`, the right path, the right `$1::jsonb` placeholder, and `true` for `create_missing`. Mocked tests can't catch this class of bug because they never execute the SQL.
- **Checking `rowCount` after the UPDATE.** UPDATE returns `rowCount: 1` because a row matched the WHERE clause. The fact that the assignment was a no-op doesn't surface as a row-not-affected signal.
- **Re-reading the documentation header in `insight.ts`.** The header says "single-statement `jsonb_set(...)`, never read-modify-write of the blob" — which the code follows. The advice is correct; we just hadn't realized `jsonb_set` has a sharper edge than we'd internalized.

## Solution

Replace `jsonb_set` with **deep-merge via the JSONB concat operator (`||`) plus `jsonb_build_object` at each level**. The merge composes its own intermediate object, sidestepping `jsonb_set`'s parent-must-exist requirement entirely:

```sql
UPDATE workspaces
   SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
         'fleetgraph',
         COALESCE(settings->'fleetgraph', '{}'::jsonb)
           || jsonb_build_object('sweep_enabled', $1::jsonb)
       )
 WHERE id = $2;
```

Reading outside-in:

- **Outer `||`** merges into the top-level `settings` blob. Preserves any unrelated namespaces (`notifications.*`, etc.).
- **Inner `||`** merges into the `fleetgraph` sub-object. Preserves any sibling fleetgraph keys (e.g. setting `sweep_enabled` doesn't disturb `llm_verdicts_enabled`).
- **Both `COALESCE(...)` calls** handle the column-is-NULL and sub-object-is-missing cases defensively. Either branch returns `'{}'::jsonb` as the merge base.

The shipped fix is in `api/src/services/workspace-settings.ts`.

## Why This Works

PostgreSQL's `jsonb_set(target, path, value, create_missing)` documentation reads:

> If `create_missing` is true (the default), then the value is *added* if it is missing — but only if the path's parent already exists.

The word "parent" is doing heavy lifting. For `path = '{fleetgraph, sweep_enabled}'`, the parent is `settings.fleetgraph`. If `settings.fleetgraph` doesn't exist in the input JSONB, the function has no parent object to add the leaf to, and it returns the input unchanged. `create_missing` only creates the **leaf** key when the intermediate path is already present.

The `||` concat operator has different semantics: it returns the right-hand JSONB *merged into* the left-hand JSONB at the top level, recursing only one level deep. By composing the right-hand side ourselves with `jsonb_build_object('fleetgraph', ...)`, we own the intermediate object's existence, so the merge always lands.

## Prevention

**Always add a real-Postgres integration test** for any code path that writes to a JSONB column via a nested path. Mocked-pool tests cannot catch silent JSONB no-ops because they don't execute SQL. The repository's `*.concurrency.test.ts` pattern (`api/src/services/fleetgraph/sweep.concurrency.test.ts` is the in-repo template) runs against `ship_test` and proved the catch path here — C5 (parallel sweeps with SUPPRESS → zero rows) and C6 (fallback persists with evidence.verdict_source='deterministic') both failed loudly when the setter no-op'd.

**Diagnostic command** when in doubt about `jsonb_set` semantics on any nested path:

```bash
psql -c "SELECT jsonb_set('{}'::jsonb, '{a,b}', 'true'::jsonb, true);"
# Returns: {}   -- NOT {"a":{"b":true}}
```

If that returns `{}`, the path requires `||`-merge or a prior `jsonb_set` call that builds the parent first. The single-statement discipline (no read-modify-write of the blob) is preserved by the `||` form — it's still one UPDATE, one tx, no race window.

**Prefer `||` + `jsonb_build_object` for any write at depth ≥ 2** in this codebase. Reserve `jsonb_set` for shallow writes (depth 1) or writes where the immediate parent is known to exist (e.g., because a prior statement in the same tx created it). The asymmetry between `jsonb_set`'s "create_missing" parameter name and its actual behavior is a known PostgreSQL footgun; the merge form makes intent explicit.

**Test scenario template** for any nested JSONB write:

```typescript
// Real-Postgres test
it('writes a nested key on a fresh row (parent object does not exist)', async () => {
  // Seed a row with empty settings.
  await pool.query("INSERT INTO workspaces (name, settings) VALUES ('test', '{}'::jsonb)");
  // Exercise the setter.
  await setFleetgraphSweepEnabled(wsId, true);
  // Assert the actual stored value, not the SQL shape.
  const { rows } = await pool.query("SELECT settings FROM workspaces WHERE id = $1", [wsId]);
  expect(rows[0].settings).toEqual({ fleetgraph: { sweep_enabled: true } });
});
```

The "writes against fresh rows" path is the one mocked tests systematically miss.
