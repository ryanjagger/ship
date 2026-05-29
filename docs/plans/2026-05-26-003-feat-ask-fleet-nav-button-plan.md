---
title: "feat: Add Ask Fleet button to primary nav"
type: feat
status: completed
created: 2026-05-26
---

# feat: Add Ask Fleet button to primary nav

## Problem Frame

Fleet chat ("Ask Fleet") is currently only reachable from an in-content launcher mounted on Project and Week pages (`web/src/components/fleetgraph/FleetGraphChatLauncher.tsx`). The shipped launcher was placed in-content (not in nav) and *hides* entirely when the AI provider is off. That hide behavior is an **implementation choice** of the launcher, not a stated requirement — R18/AE4 require Fleet to be *unavailable* when `FLEET_AI_PROVIDER=none` (no degraded/deterministic fallback), but say nothing about presentation. Hide and grey-with-tooltip are both valid expressions of "unavailable" (see origin: `docs/brainstorms/fleetgraph-agentic-graph-requirements.md`).

This plan adds a **persistent** "Ask Fleet" entry point at the top of the primary nav (the 48px icon rail in `web/src/pages/App.tsx`). Unlike the in-content launcher, the nav button is always present and **greys out** (with an explanatory tooltip) rather than disappearing when Fleet can't act. Because the nav button is enabled only when a focal Project/Week entity is present, it preserves R10's context-scoped, non-route-agnostic property — it is not a standalone chatbot. The chosen presentation — an always-visible greyed affordance — is a deliberate discovery bet by the user: signal that Fleet exists from anywhere, at the cost of the icon being greyed on routes without a focal entity.

**Enablement rule (confirmed with user):** the nav button is clickable only when Fleet is configured **and** the current page has a Fleet-addressable focal entity (a Project or a Week). It is greyed everywhere else and whenever `FLEET_AI_PROVIDER=none`, with the tooltip explaining which condition failed.

---

## Scope Boundaries

**In scope:**
- A new "Ask Fleet" `RailIcon` rendered first/top in the icon rail's mode-icon group.
- A disabled/greyed visual + tooltip state for `RailIcon` (it has none today).
- Deriving the current focal Fleet entity (project / week) from `CurrentDocumentContext` and combining it with `useFleetGraphAvailability()` to decide enabled vs. greyed.
- A shared open mechanism so the nav button and the existing in-content launcher drive a **single** chat drawer instance.

**Out of scope (true non-goals):**
- A "no-entity" / global chat mode (chat still requires a project or week entity).
- Extending Fleet chat to new entity types (issues, wikis, programs). The mapping stays project→project, sprint→week, matching the shipped backend.
- Any backend / API change. `GET /api/fleetgraph/availability` and the chat endpoints are reused unchanged.
- Changing the in-content launcher's *visual* placement or its hide-when-unavailable behavior on the page.

### Deferred to Follow-Up Work
- A keyboard shortcut (e.g. Cmd-K) to open Fleet chat — no shortcut exists today and none is requested here.
- Mapping weekly_plan / weekly_retro documents (which carry `properties.project_id`) to their parent project as a Fleet entity. Possible later; today's launcher only handles `project` and `sprint`.

---

## Key Technical Decisions

**1. Shared drawer state via a small `FleetChatProvider`, single drawer at app root.**
Today the drawer's open state lives locally inside `FleetGraphChatLauncher`. With a second trigger (the nav button), the cleanest design is a lightweight context that holds `{ isOpen, entity, open(entity), close() }`, with one `<FleetGraphChat>` mounted once near the app root. Both the nav `RailIcon` and the in-content launcher call `open(entity)`.
*Rationale:* on a Project page **both** triggers are present simultaneously. Independent local-state drawers would mean two `FleetGraphChat` instances with divergent conversation state — a real bug, not a hypothetical. A single shared drawer is the YAGNI-honest minimum that prevents it.
*Alternative considered:* nav button owns its own drawer instance reading entity from context, leaving the launcher untouched. Simpler diff, but reintroduces the dual-drawer problem above. Rejected.

**2. Greyed-out (disabled), not hidden, for the nav button.**
The in-content launcher hides when unavailable; the nav button greys. This asymmetry is deliberate: the launcher is a page-local affordance that declutters by disappearing when not actionable, while the nav button is a fixed structural element of the rail — hiding it would shift the rail layout and erase the feature's existence. Both presentations satisfy R18 (the feature is genuinely unavailable in either case). On a Project page with the provider off, the launcher disappears and the nav icon greys with "Fleet is not configured" — the user's mental model is "Fleet is off right now," which both controls reinforce.

**3. Enablement = provider available AND focal entity present.**
Derived from `useFleetGraphAvailability()` (existing hook) AND a new `useFleetChatEntity()` that maps `CurrentDocumentContext` → `{ entityId, entityType }` (project→`project`, sprint→`week`, else `null`). Greyed when either is missing; tooltip copy distinguishes the two reasons.

**4. `CurrentDocumentProvider` already wraps `AppLayout`** (`web/src/main.tsx:203`), so the rail can consume focal-document context with no provider lifting required. Confirmed during research.

---

## Implementation Units

### U1. Shared Fleet chat drawer state (`FleetChatProvider`)

**Goal:** Introduce a single source of truth for the chat drawer's open state and target entity, with one drawer instance mounted at the app root.

**Requirements:** Enables multiple triggers for one drawer; preserves existing chat behavior (origin R10/R15).

**Dependencies:** none.

**Files:**
- `web/src/contexts/FleetChatContext.tsx` (new) — provider + `useFleetChat()` hook exposing `{ isOpen, entity, open(entity), close() }`, where `entity` is `{ entityId: string; entityType: FleetGraphEntityType } | null`.
- `web/src/main.tsx` (modify) — wrap the `AppLayout` route element with `FleetChatProvider` (inside `CurrentDocumentProvider`); mount a single `<FleetGraphChat>` driven by the provider state. The wrap must sit above the route's `<Outlet/>` so both the rail (in `AppLayout`) and the in-content launcher (deep in the routed page) can consume `useFleetChat()`.
- `web/src/contexts/FleetChatContext.test.tsx` (new, co-located) — unit tests.

**Approach:** `open(entity)` sets `entity` and `isOpen=true`; `close()` sets `isOpen=false`. `entity` is **cleared on `close()`** — every `open()` call passes an entity (the contract is "no entity, no open"); there is no argument-less re-open. `FleetGraphChat` already accepts `open`, `onClose`, `entityId`, `entityType` props — wire them from provider state, passing `open={false}` when `entity` is null. Reuse the existing `FleetGraphEntityType` from `web/src/hooks/useFleetGraphChat.ts`.

**Critical — entity-scoped conversation isolation.** `useFleetGraphChat` holds `messages`, `conversationId`, `pendingProposal`, `error`, and `status` in component-local `useState` with no reset when `entityId`/`entityType` change (its only lifecycle effect runs on `[]`). Today this is safe because the launcher mounts a *fresh* `FleetGraphChat` per page, so navigating Project A → Project B remounts and re-initializes. A single always-mounted root drawer breaks that: opening for Project B after a session on Project A would carry over A's transcript and `conversationId`, and `runTurn` would POST the stale `conversationId` with B's `entityId` — the exact cross-entity conversation-bleed bug this provider exists to prevent. **Force a remount per entity** by keying the root drawer: `<FleetGraphChat key={`${entity.entityType}:${entity.entityId}`} … />`. This also makes the "cleared on close" contract clean — there is no stale per-entity state to leak.

**Out of scope (matches today's behavior):** `FleetGraphChat`'s `initialConversationId` prop (re-surfaces a prior conversation's history + pending proposal on open) is *not* wired here, exactly as the current launcher does not wire it. Resuming a server-side pending proposal across drawer re-opens remains out of scope; the key-based remount means each open starts a fresh client conversation. Note this explicitly so the implementer does not assume R10/R15 resume-on-reopen is in scope.

**Patterns to follow:** `web/src/contexts/CurrentDocumentContext.tsx` for context+hook shape and the "throw if used outside provider" guard.

**Test scenarios:**
- `open({id, type})` then read state → `isOpen` true and `entity` equals the passed value.
- `close()` after open → `isOpen` false AND `entity` is null (cleared contract).
- Calling `useFleetChat()` outside the provider throws a clear error (mirror CurrentDocumentContext).
- Opening with a new entity while already open swaps the entity (latest entity wins).
- Entity isolation: open for entity A, close, open for entity B → the rendered drawer shows an empty transcript and no carried-over `conversationId` (verifies the key-based remount; this is the regression guard for the cross-entity bleed bug).

**Verification:** Provider compiles and `pnpm type-check` passes; the single root drawer opens/closes via provider actions in the unit test.

---

### U2. Add disabled/greyed state to `RailIcon`

**Goal:** Give `RailIcon` (`web/src/pages/App.tsx`) a non-interactive greyed state with a tooltip, since none exists today.

**Requirements:** Supports the nav button's greyed presentation per Key Decision 2.

**Dependencies:** none.

**Files:**
- `web/src/pages/App.tsx` (modify) — extend `RailIcon` signature with optional `disabled?: boolean` and `disabledLabel?: string`.
- `web/src/pages/RailIcon.test.tsx` (new, co-located) — verify against the existing co-located `*.test.tsx` layout in `web/src`.

**Approach:** Use **`aria-disabled="true"` + `tabindex={0}`** for the disabled state, **not** the native `disabled` attribute. Rationale: a natively-`disabled` button suppresses pointer events in Firefox (and historically Safari), so the `Tooltip`'s hover handler never fires — the greyed icon would show with no explanation, defeating the entire discoverability mechanism. With `aria-disabled`, the button stays hover- and keyboard-reachable so the tooltip renders; guard `onClick` to no-op when disabled (a real guard, since the element is still clickable). Apply a muted/`opacity-40` style (follow the existing `text-muted` + opacity disabled pattern in `App.tsx`), suppress `active`/hover styling, and keep a visible focus ring (the disabled icon is still tab-focusable, so WCAG 2.4.7 requires it). Feed `disabledLabel ?? label` as both the `Tooltip` content and the `aria-label`.

**Patterns to follow:** existing `RailIcon` at `web/src/pages/App.tsx:609`; `Tooltip` usage with `side="right"`; the `opacity-40`/`text-muted` disabled styling already present on sidebar buttons in the same file. Before coding, confirm whether `web/src/components/ui/Tooltip.tsx` already wraps its trigger in a pointer-capturing element — if it does, the wrapper concern is moot, but `aria-disabled` is still preferred for keyboard tooltip reachability.

**Test scenarios:**
- `disabled` true → clicking does not invoke `onClick`; `aria-disabled="true"` is set (not the native `disabled` attribute).
- `disabled` true → button is keyboard-focusable (`tabindex=0`) and shows a focus ring; tooltip content renders on hover/focus.
- `disabled` true → `active` styling is not applied even if `active` is also true (disabled visually dominates).
- `disabledLabel` provided → tooltip/`aria-label` reflects the disabled explanation, not the base label.
- `disabled` false (default) → behavior identical to current `RailIcon` (regression guard: clicking fires `onClick`, active styling applies, hover styling unchanged).

**Verification:** Snapshot/visual diff shows greyed icon; existing rail icons unaffected; `pnpm type-check` passes.

---

### U3. Derive focal Fleet entity and add the "Ask Fleet" nav button

**Goal:** Add the "Ask Fleet" `RailIcon` first in the rail's mode-icon group, enabled only when a provider is configured and the current page is a Project or Week, greyed otherwise with the correct tooltip.

**Requirements:** The core feature; honors origin R18/AE4 (greyed when provider off) and the context-scoped model (R10).

**Dependencies:** U1, U2.

**Files:**
- `web/src/hooks/useFleetChatEntity.ts` (new) — reads `useCurrentDocument()` and returns `{ entityId, entityType } | null` (project→`project`, sprint→`week`, else `null`).
- `web/src/pages/App.tsx` (modify) — render an "Ask Fleet" `RailIcon` as the **first** item inside the mode-icon group `<div>` (immediately before the Dashboard `RailIcon` at `web/src/pages/App.tsx:375`). Wire `disabled`, `disabledLabel`, and `onClick`.
- `web/src/hooks/useFleetChatEntity.test.tsx` (new, co-located).
- `web/public/ship.png` (already placed) — the Fleet icon asset: a white-on-black mark downscaled to 128×128 (~8 KB). Served by Vite at `/ship.png`. No build-step change needed.

**Approach:**
- Enabled iff `available === true` (from `useFleetGraphAvailability()`) AND `useFleetChatEntity()` returns non-null.
- `onClick` → `useFleetChat().open(entity)` (entity is guaranteed non-null when enabled).
- `disabledLabel`: when `available === false` → "Fleet is not configured"; when entity is null (provider available) → "Open a project or week to ask Fleet". During the availability probe (`available === undefined`, sub-second) the button is greyed but uses the neutral base label "Ask Fleet" rather than the misconfigured-provider copy. When enabled, `label` = "Ask Fleet".
- **Icon:** the `ship.png` graphic at `/ship.png`, rendered as an `<img src="/ship.png" alt="" className="h-5 w-5 object-contain" />` passed as the `RailIcon`'s `icon` node. It is a **white-on-black raster mark**, not a `currentColor` SVG like the other rail icons — so it will not recolor on hover/active, and its black backing blends into the dark rail (`bg-background`). The greyed state still reads correctly because U2 dims via `opacity-40` (which works on an `<img>`). Verify during implementation that the black backing blends cleanly against the rail background in both themes — if a hard square edge shows (e.g. in light mode), add `rounded` to the `<img>` or confirm the design is dark-rail-only. Keep `alt=""` since the adjacent tooltip/`aria-label` already names the control.
- **Distinguish action from nav:** the button opens a drawer and is never `active`, unlike the navigation-mode icons below it. Add a small visual separator — extra bottom margin or a thin `border-b border-border` on the Fleet button — so a user scanning the rail reads it as a distinct action, not a sixth navigation mode.
- The button is not tied to `activeMode`, so `active` stays false.

**Note on weekly docs:** `weekly_plan` / `weekly_retro` documents carry a `properties.project_id` and are treated as project-context elsewhere in `App.tsx` (active-mode logic ~line 180), but `useFleetChatEntity` returns `null` for them in this iteration — so the button greys on those pages. This matches the deferred-work boundary below (the launcher itself only handles `project`/`sprint` today). Call it out so the greying is understood as intentional, not a bug.

**Patterns to follow:** existing `RailIcon` invocations at `web/src/pages/App.tsx:375-405`; `useFleetGraphAvailability` in `web/src/hooks/useFleetGraphChat.ts`; entity-type mapping comments in `web/src/components/UnifiedEditor.tsx` (project / week mapping).

**Test scenarios:**
- `useFleetChatEntity`: currentDocumentType `project` → `{entityId, entityType:'project'}`; `sprint` → `{..., 'week'}`; `wiki`/`issue`/`program`/`null` → `null`.
- Nav button renders first in the mode-icon group (assert DOM order relative to the Dashboard icon).
- Provider available + on a Project page → button enabled; clicking calls `open` with `{entityId: docId, entityType:'project'}`.
- Provider available + on a Week page → enabled; opens with `entityType:'week'`.
- Provider available + on a wiki/issue/dashboard/`weekly_plan` → greyed; tooltip "Open a project or week to ask Fleet"; clicking is a no-op.
- `available === false` (provider off) on a Project page → greyed; tooltip "Fleet is not configured". Covers the origin requirement that Fleet is fully unavailable when `FLEET_AI_PROVIDER=none` (no degraded fallback) — origin AE4.
- Availability still loading (`available === undefined`) → greyed (not enabled) until known, with the neutral "Ask Fleet" tooltip (not "Fleet is not configured").

**Verification:** On `pnpm dev`, the "Ask Fleet" icon sits at the top of the rail; it is clickable and opens the drawer on Project/Week pages, greyed with the right tooltip elsewhere and when the provider is off.

---

### U4. Route the in-content launcher through the shared drawer

**Goal:** Make `FleetGraphChatLauncher` open the shared drawer (U1) instead of owning a local `FleetGraphChat` instance, so only one drawer ever exists.

**Requirements:** Prevents dual-drawer divergence (Key Decision 1); preserves the launcher's hide-when-unavailable behavior (R18).

**Dependencies:** U1.

**Files:**
- `web/src/components/fleetgraph/FleetGraphChatLauncher.tsx` (modify) — drop local `open` state and the embedded `<FleetGraphChat>`; on click call `useFleetChat().open({ entityId, entityType })`. Keep the `available !== true` early return (the launcher still hides on the page).
- `web/src/components/fleetgraph/FleetGraphChat.test.tsx` (update existing) — the launcher's existing tests live here; update them to assert delegation to the shared provider rather than local drawer state.

**Approach:** The launcher remains the page-level affordance and keeps hiding when unavailable; it just no longer renders its own drawer. The single root drawer (U1) is the only `FleetGraphChat`.

**Patterns to follow:** existing `FleetGraphChatLauncher.tsx`; the `useFleetChat()` hook from U1.

**Test scenarios:**
- Launcher click invokes `useFleetChat().open` with the page's entity (not local state).
- Only one `FleetGraphChat` is present in the DOM when both the launcher and nav button are rendered on a Project page.
- `available !== true` → launcher renders nothing (regression guard on R18 behavior unchanged).

**Verification:** On a Project page, opening from either the nav button or the in-content launcher controls the same drawer; no duplicate drawer in the DOM.

---

## System-Wide Impact

- **`web/src/pages/App.tsx`** — `RailIcon` gains a disabled state (backward compatible; default false) and one new icon is added to the rail. No change to existing navigation modes.
- **`web/src/main.tsx`** — one new provider wrapper and one root-mounted drawer.
- **`web/src/components/fleetgraph/FleetGraphChatLauncher.tsx`** — internal refactor; same external behavior on the page.
- **No API/backend impact.** Availability and chat endpoints are reused as-is.
- **Accessibility:** the rail already declares `role="navigation"`; the disabled icon must keep an accessible name explaining why it's disabled (handled via `disabledLabel` → `aria-label`/tooltip in U2).

---

## Risks & Mitigations

- **Dual drawers / divergent conversation state** — mitigated by U1's single root drawer; U4 enforces the launcher uses it. Test asserts exactly one drawer in the DOM.
- **Cross-entity conversation bleed** — the single always-mounted drawer would otherwise reuse `useFleetGraphChat`'s component-local state across entities. Mitigated by the per-entity `key` remount in U1; a dedicated test guards it.
- **Disabled tooltip silence** — a natively-`disabled` button drops hover events in Firefox/Safari, so the greyed icon would have no explanation. Mitigated by U2's `aria-disabled` + `tabindex` approach, which keeps the tooltip reachable.
- **Availability probe failure stays greyed for the cache TTL** — if `GET /api/fleetgraph/availability` fails transiently it returns `false` and is cached ~5 min, so the button stays greyed even where Fleet is actually up. Accepted for this iteration (matches the existing launcher, which hides on the same signal); revisit if it proves noisy.

**Open decision (user owns):** The always-visible greyed affordance is a discovery bet — the icon is greyed on the default `/my-week` landing route and all list views, since those set no focal entity. The user explicitly chose grey-in-context over hide. No usage instrumentation backs the "visible everywhere improves discovery" hypothesis; if discovery is the real goal, instrumenting the existing in-content launcher first would be a cheaper test. Flagged, not blocking.

---

## Requirements Traceability

| Origin (requirements doc) | Addressed by |
|---|---|
| R18 / AE4 — features unavailable when `FLEET_AI_PROVIDER=none` (no degraded fallback) | U3 greyed state + "Fleet is not configured" tooltip; U4 launcher still hides. Both are valid presentations of "unavailable" — R18/AE4 do not mandate one. |
| R10 — context-scoped chat, not a route-agnostic chatbot | U1 shared drawer seeded via `open(entity)`; U3 derives the entity from the focal doc and greys when none exists (preserving context-scoping) |
| New ask — global, persistent, greyed nav entry point | U2 + U3. New scope on top of shipped Fleet; the prior launcher was in-content by implementation choice, not by a stated "not in nav" requirement. |
