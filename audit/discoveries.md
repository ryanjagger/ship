

## WebSocket / Yjs

### Background

**WebSocket** is a long-lived, full-duplex connection over a single TCP socket. The handshake is an HTTP `GET` with `Upgrade: websocket`; once the server returns `101 Switching Protocols`, both sides exchange framed messages (text or binary) until either closes the connection. Close codes are a 4-digit int: `1000-2999` are reserved by the spec, `3000-3999` for registered protocols, **`4000-4999` are app-defined** — useful as out-of-band signals.

**Yjs** is a CRDT (conflict-free replicated data type) library. A `Y.Doc` holds shared state (text, maps, arrays, XML fragments). Edits produce **updates** — small binary diffs that can be applied in any order on any replica and converge to the same state without coordination. No locking, no central source of truth, no "who wins" logic — the math guarantees convergence.

**y-protocols** is the wire protocol on top of Yjs:
- `sync` — two-step state exchange. `SyncStep1` sends the local state vector (≈ "here's what I've seen"). The peer replies with `SyncStep2` containing only the updates the first side is missing. After that, both sides broadcast subsequent updates directly.
- `awareness` — ephemeral presence state (cursor position, selection, user name/color). Not persisted; expires on disconnect via a clientID-keyed TTL.

The framing is its own protocol: each message is a `varUint` message-type tag followed by type-specific bytes, all encoded via `lib0/encoding`. **Always binary.**

### How this codebase wires it together

Server (`api/src/collaboration/index.ts`):
- `WebSocketServer({ noServer: true })` — the Express HTTP server fires `upgrade` events; the handler decides whether to accept (`api/src/collaboration/index.ts:653-728`).
- Two endpoints share the upgrade handler:
  - **`/collaboration/{docType}:{docId}`** — per-document Yjs sync. Room name format `wiki:uuid`, `issue:uuid`, etc. The `docType` prefix is cosmetic; `parseDocId` strips it because everything lives in the unified `documents` table (`api/src/collaboration/index.ts:102-105`).
  - **`/events`** — per-user notification channel. Plain JSON messages, no Yjs. Used by `broadcastToUser` for cross-tab notifications (`api/src/collaboration/index.ts:629-644`).
- Documents are loaded lazily into a `Map<docName, Y.Doc>` on first connection (`getOrCreateDoc`, `api/src/collaboration/index.ts:195-279`), kept warm for 30s after the last disconnect, then evicted.
- Persistence is **debounced 2 s** after the last update (`schedulePersist`, `api/src/collaboration/index.ts:181-189`). On save, the Y.Doc is encoded with `Y.encodeStateAsUpdate(doc)` and written to `documents.yjs_state` (bytea). Simultaneously, the doc is converted to TipTap JSON and written to `documents.content` so REST reads don't need to crack open Yjs state.

Client (`web/src/components/Editor.tsx`):
- `new Y.Doc()` per `documentId` via `useMemo` (`web/src/components/Editor.tsx:200`).
- `new WebsocketProvider(wsUrl, room, ydoc, { connect: false })` — the `y-websocket` provider handles sync, reconnect, and awareness wiring.
- TipTap extensions: `Collaboration.configure({ document: ydoc })` replaces TipTap's history with the Yjs-aware one; `CollaborationCursor` paints other users' carets from awareness state.
- An `IndexeddbPersistence` provider runs alongside so offline edits survive a reload and merge in on reconnect.

### Message types

The server defines four (`api/src/collaboration/index.ts:14-17`):

```typescript
const messageSync = 0;          // standard y-protocols sync
const messageAwareness = 1;     // standard y-protocols awareness
const messageCustomEvent = 2;   // (reserved; not currently dispatched)
const messageClearCache = 3;    // tell client to drop IndexedDB before syncing
```

`messageClearCache` is custom — when the server loaded a doc fresh from JSON (e.g. REST-created, no `yjs_state` yet), it tells the first connecting client to wipe its IndexedDB so a stale cached state doesn't merge in and resurrect deleted content (`api/src/collaboration/index.ts:744-752`).

### Custom WebSocket close codes (4xxx)

The server uses close-code-as-side-channel — neat trick, since `ws.close(code, reason)` propagates to the client without needing a separate message format. The reason field is limited to **123 bytes**, so it's used for tiny JSON payloads.

| Code | Meaning | Source | Client handling |
|------|---------|--------|-----------------|
| `4100` | Document converted (issue ↔ project). `reason` = `JSON.stringify({newDocId, newDocType})` | `api/src/collaboration/index.ts:568` | Disable reconnect, route to new doc (`web/src/components/Editor.tsx:426-444`) |
| `4101` | Content overwritten via REST API; client should clear IndexedDB and let auto-reconnect refetch | `api/src/collaboration/index.ts:518` | `indexeddbProvider.clearData()`, then reconnect (`web/src/components/Editor.tsx:445-456`) |
| `4403` | Visibility changed to private and you're not the creator/admin | `api/src/collaboration/index.ts:615` | Disable reconnect, alert, navigate away (`web/src/components/Editor.tsx:418-425`) |

Standard codes used: `1003` (unsupported data — sent for non-binary or malformed frames), `1008` (policy violation — rate limit exceeded), `1009` (message too large).

### Defense-in-depth concerns the server takes

1. **Session auth on upgrade** (`api/src/collaboration/index.ts:707-712`) — the cookie is read from the HTTP upgrade request and validated against the `sessions` table before `handleUpgrade` is called. There's no WebSocket-native auth, so this is the only place to do it.
2. **Visibility check on upgrade** (`api/src/collaboration/index.ts:718-723`) — same query path as REST. `canAccessDocumentForCollab` is the SubPlan example called out in the previous section.
3. **Per-IP connection rate limit** — 30 connections/min/IP, sliding window (`api/src/collaboration/index.ts:53-58`).
4. **Per-connection message rate limit** — 50 msgs/sec, with progressive penalties: drop silently up to 50 violations, then close 1008 (`api/src/collaboration/index.ts:782-799`).
5. **Max payload 10 MB** — both at `WebSocketServer({ maxPayload })` and a manual length check inside `on('message')` (`api/src/collaboration/index.ts:647, 771-774`).
6. **Binary-only enforcement** on `/collaboration/*` — non-binary frames close 1003 (`api/src/collaboration/index.ts:776-779`). Stops JSON-injection attempts against the Yjs decoder.

### Awareness clientID gotcha

`api/src/collaboration/index.ts:337-349` has a comment-flagged bug fix worth knowing: when a client sent its first awareness update, the server was storing `doc.clientID` (the **server's** Y.Doc clientID) in the connection record instead of the client's actual awareness clientID embedded in the update payload. On disconnect, `removeAwarenessStates` got passed the wrong ID and the stale presence state never cleared — so refreshed users saw ghost cursors of themselves. The fix decodes the first clientID from the update payload (`[numStates, clientId, clock, stateJson]`) and stores that.

### The `connect: false` + monkey-patch dance

In `Editor.tsx:386-402`, the provider is constructed with `connect: false`, then `wsProvider.connect` is wrapped so the first thing it does after opening the underlying `WebSocket` is install a raw `'message'` event listener. Reason: `y-websocket` doesn't expose an "I just got bytes from the server" hook — its public API only fires after the y-protocols decoder consumes the bytes. To handle the custom `messageClearCache` (type 3), the client needs to peek at raw frames before the standard decoder rejects them as unknown. Wrapping `connect` is the seam.

### Persistence ordering

The flow on every edit:
1. Client edits → TipTap → Yjs update emitted locally.
2. `y-websocket` sends the update as a `messageSync` frame.
3. Server's `handleCollaborationMessage` (`api/src/collaboration/index.ts:312-365`) calls `syncProtocol.readSyncMessage(decoder, encoder, doc, ws)` — applies the update to the in-memory `Y.Doc`, passing `ws` as the **origin** so the doc's `'update'` event handler (line 262) doesn't echo back to the sender.
4. The `'update'` handler broadcasts to all other connections in the same room and calls `schedulePersist`.
5. 2 s after the last update, `persistDocument` writes `yjs_state` + extracted `content` JSON + extracted properties (`plan`, `success_criteria`, `vision`, `goals`) to Postgres in a single `UPDATE`.

The dual write (binary state + JSON content) is the **fallback layer**: if `yjs_state` is corrupted or missing, `getOrCreateDoc` falls back to `jsonToYjs(content)` (`api/src/collaboration/index.ts:215-253`). When that happens, the doc is marked in `freshFromJsonDocs` and the first connecting client gets the `messageClearCache` signal so its IndexedDB doesn't merge stale state.

### Worth knowing if you debug it

- **Stuck cursors / phantom users** → almost always the awareness-clientID issue or a missed `ws.close` cleanup. Check `conns.get(ws)?.awarenessClientId`.
- **Content "reverts" after refresh** → the client merged its IndexedDB state with a fresh server state. Either `messageClearCache` didn't fire (the doc had a `yjs_state` and wasn't in `freshFromJsonDocs`) or the REST endpoint that mutated `content` didn't call `invalidateDocumentCache` (`api/src/collaboration/index.ts:491-535`).
- **Updates not persisting** → check `pendingSaves`. If the only client disconnects within the 2s debounce window, the on-close handler at `api/src/collaboration/index.ts:822-827` forces a final persist; if not, the timeout fires normally.
- **Sync never completes** → SyncStep1 went out (server) but no SyncStep2 came back. Likely the doc wasn't loaded (`getOrCreateDoc` swallowed an error at line 257). Tail the API logs for `[Collaboration] Failed to load document`.

### How I'd apply this in a future project

1. **Reach for CRDTs only when concurrent editing is the actual requirement.** Yjs eliminates "last write wins" conflict logic, but it costs you a binary state column, a debounced persistence layer, and a dual-write JSON fallback. For single-writer or low-contention features I'd stick with plain REST + optimistic updates and skip the whole stack.
2. **Use WebSocket close codes (4000–4999) as a cheap control channel.** Before inventing a custom in-band message format for "go reconnect to a new doc id" or "drop your cache", I'd check whether a close code + 123-byte JSON reason gets the signal across, since it rides the existing close handshake with zero protocol changes.
3. **Always carry a non-CRDT fallback representation.** The dual write (binary `yjs_state` + plain `content` JSON) is what lets REST reads skip the CRDT decoder and what recovers a doc when binary state is corrupt. I'd treat the human-readable copy as the source of truth for reads and the CRDT state as an optimization, not the other way around.

## EXPLAIN / EXPLAIN ANALYZE

### The two commands

- **`EXPLAIN <query>`** — planner only. Prints the *estimated* plan (cost, row counts) without executing. Cheap. Use to spot the shape (Seq Scan vs Index Scan, join order, subplans) before you commit to running a slow query against prod.
- **`EXPLAIN ANALYZE <query>`** — **actually runs the query** and prints estimates *plus* observed timings and row counts. For `INSERT/UPDATE/DELETE`, wrap in a transaction and `ROLLBACK` if you don't want the side effect:
  ```sql
  BEGIN; EXPLAIN ANALYZE DELETE FROM documents WHERE ...; ROLLBACK;
  ```

### Useful options

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT) <query>;
```

- `ANALYZE` — execute and time
- `BUFFERS` — shared/local hit/read/dirtied counts. Critical for diagnosing cache vs disk
- `VERBOSE` — output column lists, schema-qualified names
- `SETTINGS` — non-default planner GUCs in effect (e.g. `work_mem`, `enable_seqscan`)
- `FORMAT JSON` — machine-readable; useful for piping into tools like [explain.depesz.com](https://explain.depesz.com) or [explain.dalibo.com](https://explain.dalibo.com)

### How to read a plan

Plans are trees, read bottom-up (leaves execute first, parents consume their output). Key fields on each node:

- `cost=START..TOTAL` — planner's estimate in arbitrary units (start = time to first row, total = time to last row). Compare estimates, don't read absolutely.
- `actual time=START..TOTAL` — milliseconds. `total - start` × `loops` ≈ time spent in that node + descendants.
- `rows=N` (estimate) vs `actual rows=N` — large divergence means stale stats; run `ANALYZE <table>`.
- `loops=N` — node executed N times. **`loops > 1` on a subplan or inner side of a Nested Loop is where per-row work hides.**
- `Buffers: shared hit=H read=R` — H = cache hit, R = disk read. High `read` on a hot query means working set doesn't fit in `shared_buffers`.
- `Rows Removed by Filter: N` — filter applied after scan. If high, you're missing an index or expression index.

Common node types:

| Node | What it means |
|------|---------------|
| `Seq Scan` | Full table scan. Fine for small tables, alarming on big ones with selective predicates. |
| `Index Scan` / `Index Only Scan` | B-tree lookup. `Index Only` avoids heap fetches via visibility map. |
| `Bitmap Heap Scan` + `Bitmap Index Scan` | Multiple index entries gathered, then heap fetched in physical order. Used when a single scan would return too many rows for plain Index Scan. |
| `Nested Loop` | For each outer row, scan inner. Good when outer is tiny. Catastrophic when outer is large and inner has no index. |
| `Hash Join` | Build hash from one side (usually smaller), probe with the other. One-shot; can't stream. |
| `Merge Join` | Both sides sorted, zip together. Cheap if input is already sorted (e.g. via index). |
| `Memoize` | PG 14+. Caches inner results of a Nested Loop keyed on the join key. See it below — turns N inner scans into N misses + repeat hits. |
| `Gather` / `Gather Merge` | Parallel workers. |
| `InitPlan` / `SubPlan` | See the Subplans section below. |

### Real example from this codebase

The triple-subplan query at `api/src/routes/projects.ts:1447-1455` (project → sprints with three counts), run against local seed data:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT d.id, d.title,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations da_i ON da_i.document_id = i.id
         AND da_i.related_id = d.id AND da_i.relationship_type = 'sprint'
        WHERE i.document_type = 'issue') as issue_count,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations da_i ON da_i.document_id = i.id
         AND da_i.related_id = d.id AND da_i.relationship_type = 'sprint'
        WHERE i.document_type = 'issue' AND i.properties->>'state' = 'done') as completed_count,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations da_i ON da_i.document_id = i.id
         AND da_i.related_id = d.id AND da_i.relationship_type = 'sprint'
        WHERE i.document_type = 'issue' AND i.properties->>'state' IN ('in_progress','in_review')) as started_count
  FROM documents d
  JOIN document_associations da ON da.document_id = d.id
   AND da.related_id = '<some-project-id>' AND da.relationship_type = 'project'
 WHERE d.document_type = 'sprint';
```

Trimmed plan:

```
Hash Join  (cost=11.61..114.08 rows=1 width=58) (actual time=0.204..0.543 rows=3 loops=1)
  Hash Cond: (d.id = da.document_id)
  Buffers: shared hit=150
  ->  Seq Scan on documents d  (... rows=35 loops=1)
        Filter: (document_type = 'sprint')
        Rows Removed by Filter: 222            -- ← scanning whole documents table
  ->  Hash  (... rows=17 loops=1)
        ->  Bitmap Heap Scan on document_associations da
              Recheck Cond: (related_id = '<project-id>')
  SubPlan 1
    ->  Aggregate (actual time=0.038..0.039 rows=1 loops=3)        -- ← runs once per sprint
          ->  Nested Loop
                ->  Bitmap Heap Scan on document_associations da_i
                      Index Cond: ((related_id = d.id) AND (relationship_type = 'sprint'))
                ->  Memoize (Hits: 0  Misses: 17  Evictions: 0)    -- ← cache cold this round
                      ->  Index Scan using documents_pkey on documents i
  SubPlan 2
    ->  Aggregate (actual time=0.029..0.029 rows=1 loops=3)        -- ← again
          ... (identical shape)
  SubPlan 3
    ->  Aggregate (actual time=0.026..0.026 rows=1 loops=3)        -- ← and again

Planning Time: 4.909 ms
Execution Time: 0.745 ms
```

Things to notice:

1. **`SubPlan 1/2/3` each have `loops=3`** — one execution per outer sprint row. With 3 sprints that's 9 inner executions total; with 30 sprints it'd be 90. This is the SubPlan pattern from the previous section, made concrete.
2. **`Memoize` shows `Hits: 0 Misses: 17`** — PG 14+ caches inner results of nested loops keyed on `da_i.document_id`. All misses here because each sprint's issue set is distinct; if many sprints shared issues we'd see hits.
3. **`Rows Removed by Filter: 222`** on `Seq Scan on documents d` — scanning the whole documents table to find 35 sprints. Acceptable at 257 rows; at 100k it would need `idx_documents_type` (or a partial index on `document_type='sprint'`).
4. **`Buffers: shared hit=150`** — entirely in cache. No `read=` means no disk I/O this run; numbers would be larger on a cold cache.
5. **Planning Time (4.9 ms) > Execution Time (0.7 ms)** — common for trivial queries. On hot endpoints, large planning time can dominate; mitigations are prepared statements, `plan_cache_mode`, or simpler queries.

### Rewrite comparison

Same data via `LEFT JOIN ... GROUP BY` with `COUNT(*) FILTER`:

```sql
SELECT d.id, d.title,
       COUNT(*) FILTER (WHERE i.document_type='issue') as issue_count,
       COUNT(*) FILTER (WHERE i.document_type='issue' AND i.properties->>'state'='done') as completed_count,
       COUNT(*) FILTER (WHERE i.document_type='issue' AND i.properties->>'state' IN ('in_progress','in_review')) as started_count
  FROM documents d
  JOIN document_associations da ON da.document_id = d.id
   AND da.related_id = '<project-id>' AND da.relationship_type = 'project'
  LEFT JOIN document_associations da_i ON da_i.related_id = d.id AND da_i.relationship_type = 'sprint'
  LEFT JOIN documents i ON i.id = da_i.document_id
 WHERE d.document_type = 'sprint'
 GROUP BY d.id, d.title;
```

Trimmed plan:

```
GroupAggregate  (cost=40.26..40.30 rows=1 width=58) (actual time=0.326..0.340 rows=3)
  Group Key: d.id
  Buffers: shared hit=71                       -- ← half the buffer touches
  ->  Sort
        ->  Nested Loop Left Join
              ->  Nested Loop Left Join
                    ->  Hash Join (d × da)
                    ->  Index Scan on document_associations da_i
              ->  Index Scan using documents_pkey on documents i

Planning Time: 3.275 ms
Execution Time: 0.519 ms
```

Differences:

- **No `SubPlan` nodes.** One scan over the issue set, aggregated with `FILTER`.
- **`shared hit=71` vs `150`** — roughly half the buffer touches on this tiny dataset; the gap widens as the sprint set grows because the original re-touches `documents_pkey` 3× per sprint.
- Execution time is similar at this scale (sub-millisecond); the *cost estimate* (`40` vs `114`) is the planner's hint that the rewrite scales better.

### Practical workflow

1. `EXPLAIN <query>` first — cheap sanity check on shape.
2. `EXPLAIN (ANALYZE, BUFFERS) <query>` on a representative dataset.
3. Look for: `loops > 1` on inner sides, `Seq Scan` over big tables with selective filters, large `Rows Removed by Filter`, estimate-vs-actual divergence > 10×.
4. If estimates are off → `ANALYZE <table>;` to refresh stats.
5. For complex plans, paste the JSON form into explain.depesz.com to highlight hot spots.

### How I'd apply this in a future project

1. **Make `EXPLAIN (ANALYZE, BUFFERS)` the default reflex for any list/aggregate endpoint, not a last resort.** I'd run it against representative (not toy) seed data the moment a query touches more than one table, watching specifically for `loops > 1` on inner nodes and large `Rows Removed by Filter` — both surface scaling problems long before they page someone in prod.
2. **Trust the cost estimate over wall-clock time when judging scalability.** On small/dev datasets two plans often run in the same sub-millisecond range; the `cost` divergence (e.g. 40 vs 114 here) is the planner telling you which one degrades as rows grow, so I'd compare costs, not stopwatch numbers, when choosing a rewrite.
3. **Wrap write-path checks in `BEGIN; … ROLLBACK;`.** To profile a `DELETE`/`UPDATE` safely I'd analyze it inside a transaction and roll back, which lets me measure real plans against real data without mutating it.

## PostgreSQL Subplans

Subplans are execution-plan nodes the planner emits for subqueries that aren't flattened into joins. Two flavors:

- **InitPlan** — runs once before the outer query. Uncorrelated subqueries (e.g. `WHERE x = (SELECT max(...) FROM ...)`). Result is cached and reused. Variant: Hashed SubPlan when the IN-list is uncorrelated and hashable.
- **SubPlan** — runs per outer row. Correlated (inner references outer row) `IN (SELECT …)` / `EXISTS (…)` that the planner can't rewrite as a semijoin.

Why care: a correlated SubPlan looks like one SQL statement but executes the inner query N times. `EXPLAIN ANALYZE` shows `loops=N` on the subplan node. Usual fix: rewrite to `JOIN`, `LATERAL`, `GROUP BY` + `FILTER`, or window function.

### Examples in this codebase

**Correlated SubPlan (per-row) — `api/src/routes/projects.ts:665-670`**

```sql
SELECT d.id, ...,
       (SELECT COUNT(*) FROM documents s
        JOIN document_associations da
          ON da.document_id = s.id
         AND da.related_id = d.id          -- correlates to outer
         AND da.relationship_type = 'project'
        WHERE s.document_type = 'sprint') as sprint_count,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations da
          ON da.document_id = i.id
         AND da.related_id = d.id          -- correlates to outer
         AND da.relationship_type = 'project'
        WHERE i.document_type = 'issue') as issue_count
  FROM documents d ...
```

Here `d` is filtered to a single id so it's only two executions — fine. The same shape at `projects.ts:1447-1455` (and the duplicate at `:1507-1515`) runs across every sprint in a project with **three** correlated count subqueries → 3N executions. Called from `GET /api/projects/:id/weeks`. Candidate for `LEFT JOIN document_associations + GROUP BY` with conditional `COUNT(*) FILTER (WHERE …)`.

**Uncorrelated InitPlan — `api/src/routes/documents.ts:1024`**

```sql
DELETE FROM documents WHERE id IN (SELECT id FROM descendants)
```

`descendants` doesn't reference the outer row → planner runs it once as InitPlan (often Hashed) and probes per outer row. Same shape at `migrations/013_fix_duplicate_users.sql:60` (`WHERE user_id NOT IN (SELECT id FROM users)`) and several test cleanup paths (`DELETE … WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`).

**EXISTS SubPlan in SELECT list — `api/src/routes/caia-auth.ts:388`**

```sql
EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.user_id = u.id)
   as has_membership
```

Correlated on `u.id`. PG sometimes rewrites correlated `EXISTS` in `WHERE` to a semijoin, but inside a SELECT-list projection it stays a SubPlan. Short-circuits on first match per outer row.

**Nested InitPlans in a CTE chain — `api/src/routes/activity.ts:115-119`**

```sql
id IN (SELECT document_id FROM document_associations WHERE related_id = $1 ...)
OR id IN (SELECT document_id FROM document_associations
          WHERE related_id IN (SELECT id FROM program_projects) ...)
OR id IN (SELECT document_id FROM document_associations
          WHERE related_id IN (SELECT id FROM program_sprints) ...)
```

Each `IN (SELECT … WHERE related_id IN (SELECT …))` is uncorrelated → InitPlans / Hashed SubPlans. The `OR` between three `IN`-lists is the risk — `OR` of subplans frequently defeats index use and degrades to a Seq Scan. Usual rewrite is `UNION ALL` of three branches.

### How to verify

`EXPLAIN (ANALYZE, VERBOSE)` against a seeded DB; look for `InitPlan N`, `SubPlan N`, or `Hashed SubPlan` nodes with `(actual rows=… loops=N)`. `loops > 1` confirms per-row execution.

Hottest one to inspect: **`projects.ts:1447-1515`** — three correlated counts per sprint row, hit on the project detail page.

### How I'd apply this in a future project

1. **Treat a correlated subquery in a SELECT list as a per-row loop, not one query.** When I see `(SELECT COUNT(*) … WHERE x = outer.id)` projected over a result set — especially several of them — I'd assume N (or 3N) executions and reach for `LEFT JOIN … GROUP BY` with `COUNT(*) FILTER (WHERE …)`, which collapses the repeated subplans into a single pass.
2. **Distinguish InitPlan from SubPlan before optimizing.** An uncorrelated `IN (SELECT …)` runs once (InitPlan) and is usually fine to leave alone, whereas a correlated one runs per row; knowing which I'm looking at stops me from "fixing" a query that the planner already hoisted.
3. **Be suspicious of `OR` between multiple `IN (SELECT …)` branches.** That pattern frequently defeats index use and degrades to a Seq Scan, so in a future project I'd default to rewriting it as `UNION ALL` of the branches and confirm the index-scan plan with `EXPLAIN`.
