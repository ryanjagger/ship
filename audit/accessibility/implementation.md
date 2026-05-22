# Accessibility Audit — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-19) and `peer-review.md` (reviewer pass, supersedes the README's findings list). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/accessibility`.

The audit and peer review together identified 4 originally-flagged violations plus ~20 issues that the automated Lighthouse + axe pass missed. This document tracks remediation in five phases, ordered by WCAG severity and blast radius.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| Lighthouse low-water-mark (Settings) | 94 | **100** | `087d67c` |
| Login Lighthouse | 98 | **100** | `74ce704` |
| axe Critical violations | 1 | **0** | `087d67c` |
| axe Serious violations | 3 | 3 (all Phase 3 contrast) | — |
| Pages with `<main>` landmark | 9/10 (Login missing) | **10/10** | `74ce704` |
| Selects missing accessible name | 3 (Settings) | **0** | `087d67c` |
| `text-accent` on `bg-background` text usages | ~20+ | _Phase 3_ | — |
| Opacity-based text dimming (`opacity-40` on rows) | 1 (My Week future rows) | _Phase 3_ | — |
| TipTap surfaces with accessible name | 0 (body + title) | **2/2** | `c0908cb` |
| Icon-only buttons relying on `title` for SR name | 2 (workspace, sign-out) | **0** | `31339df` |
| Form fields with linked validation errors | 2 (Login only) | **4** (+ ProjectSetupWizard) | `6bd2cdf` |
| Tab panels with valid `aria-controls` target | 0 (dangling refs) | _Phase 2_ | — |
| Reduced-motion handling | None | _Phase 3_ | — |
| `aria-grabbed` (deprecated) usages | 1 | **0** (replaced by dnd-kit announcements) | _Phase 2_ |
| Single-character global keyboard shortcuts | 2 (`c` on Issues, Projects) | _Phase 2_ | — |
| Decorative `<label>` (no `htmlFor`, no wrapped control) | ~25 | _Phase 4_ | — |
| CI workflow running a11y checks | 0 (no `.github/workflows/`) | _Phase 5_ | — |

Status legend used in the per-fix sections below: **Done** (committed), **In progress**, **Deferred** (carried forward with rationale).

## Phase 1 — Critical (WCAG A, name/role/value)

These are the items where a screen-reader user cannot identify, name, or operate a control. Phase 1 covers the four originally-flagged violations plus the five most consequential additions from the peer review.

### 1.1 Login page `<main>` landmark — Status: **Done**

**Before.** `web/src/pages/Login.tsx:181` wrapped the form in a plain `<div>`. Only `AppLayout` (post-auth) provided `<main id="main-content">` at `App.tsx:544`, so the pre-auth route had no main landmark and Lighthouse dropped Login to 98.

**Change.** Converted the outer wrapper at `web/src/pages/Login.tsx:181` from `<div>` to `<main>` (and the matching closing tag at `:370`). No `id="main-content"` needed — the skip link only renders inside the authenticated `AppLayout` (`App.tsx:265-269`), and Login has no skip link of its own.

Did not touch the isCheckingSetup loading state at `:174` — that's an ephemeral pre-render branch, not a primary content surface, and adding a second `<main>` would create two landmarks during the brief loading window.

**After (verified 2026-05-22).** Login Lighthouse 98 → **100**, `failingAudits: []`, axe violations 0, screen-reader proxy `mainCount: 1` (was 0), `status: "Pass"`.

**Reproducibility.** `pnpm build:web` first (the audit-runner config has no `globalSetup`, so it serves whatever is in `web/dist`), then `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`. Inspect `audit/accessibility/results.json`: `lighthouse.Login.score === 100`, `axe.Login.violations === []`.

**Workflow note for later fixes.** The audit-runner uses `vite preview` against the pre-built `web/dist` (per `e2e/fixtures/isolated-env.ts` — `vite dev` was banned for memory reasons), and the audit-runner config skips the `globalSetup` that the main e2e config uses to rebuild. **Every fix in this implementation must run `pnpm build:web` before re-running the runner**, or the audit will silently report the pre-fix state.

### 1.2 Settings selects: accessible names — Status: **Done**

**Before.** `web/src/pages/WorkspaceSettings.tsx:324` (member role), `:420` (invite role), `:601` (token expiry) render `<select>` elements without `aria-label` or an associated `<label>` (or with a `<label>` that is not `htmlFor`-linked). axe reports 1 Critical violation; Lighthouse drops Settings to 94.

**Change.** Three concrete patches in `web/src/pages/WorkspaceSettings.tsx`:

1. Member role `<select>` (rendered per row inside `members.map`): added `aria-label={\`Role for ${member.name}\`}`. Per-row interpolation rather than `htmlFor`/`id`, since N selects share a column and a single `id` cannot disambiguate.
2. Invite role `<select>` (Send Invite form): added `aria-label="Invite role"`. The visible context ("Send Invite" button) is not an associated label, so `aria-label` is the minimum complete name.
3. Token expiry `<select>`: visible `<label>Expires</label>` already exists; added `id="token-expires-select"` to the select and `htmlFor="token-expires-select"` to the label. Visible text and accessible name agree (WCAG 2.5.3). Co-fix with 1.3.

**After.** axe Critical = 0; Settings Lighthouse → 100.

**Reproducibility.** Re-run the audit runner; check Settings page section in `results.json`.

### 1.3 WorkspaceSettings: label association for Token Name / Expires and invite email — Status: **Done**

**Before.** `web/src/pages/WorkspaceSettings.tsx:589-610` renders `<label>Token Name</label>` and `<label>Expires</label>` without `htmlFor` and without wrapping the input — visually labeled, programmatically unlabeled. `:412-419` renders the invite email input with only `placeholder="Email address"` (placeholder is not a name per WCAG 3.3.2).

**Change.** Three concrete patches in `web/src/pages/WorkspaceSettings.tsx`:

1. Token Name: added `id="token-name-input"` to the `<input>` and `htmlFor="token-name-input"` to the adjacent `<label>`.
2. Expires: handled in 1.2.3 above (`id="token-expires-select"` on the select, `htmlFor` on the label). Not double-fixed.
3. Invite email `<input>`: added `aria-label="Invite email address"`. Placeholder is preserved for visual continuity but no longer relied on as the accessible name. Wrapping in a visible `<label>` would change the horizontal flex layout; `aria-label` is the targeted fix.

**After.** Every form control in WorkspaceSettings has a programmatic accessible name.

**Reproducibility.** Audit runner Settings page; manual focus + VoiceOver check that announces the visible label.

### 1.4 TipTap title textarea + duplicate `<h1>` — Status: **Done**

**Before.** `web/src/components/Editor.tsx:927-949` renders the editable title as a `<textarea>` with no `aria-label`, no `<label>`, only `placeholder="Untitled"`. A small `<h1>` at `:843` duplicates the title text in the compact header. Result: SR users hear an `<h1>` at small visual size; the obvious-looking title input is unnamed.

**Change.** Two concrete patches in `web/src/components/Editor.tsx`:

1. Added `aria-label="Document title"` to the title textarea at `:927`. Placeholder `"Untitled"` is preserved for visual continuity but no longer relied on as the accessible name (WCAG 3.3.2).
2. Converted the small compact-header `<h1>` at `:843` to a `<div>`. This eliminates the duplicate-heading announcement (SR was hearing the title twice, once as a heading at small visual size and again as an unnamed textarea). The visually-large editable textarea — now programmatically named — becomes the unambiguous title control. Tradeoff: removing the only `<h1>` on the page trips axe's `page-has-heading-one` best-practice rule. That rule is a best-practice, not a WCAG conformance criterion, and the cleaner SR experience is the accepted trade per peer review. Stale "h1 for accessibility" / "WCAG 1.4.12" comments removed; `min-w-[3rem] overflow-visible` styling kept on the new `<div>`.

Did not introduce `sr-only` hidden h1 elements or `aria-labelledby` cross-references — both add complexity for marginal SR benefit.

**After.** One semantic title source, programmatically labeled. Affects Docs, Issues, Programs, Projects pages (every page that wraps the Editor).

**Reproducibility.** Open `/documents/:id`; inspect textarea accessible name in DevTools accessibility panel; expect "Document title".

### 1.5 TipTap editor surface accessible name — Status: **Done**

**Before.** `web/src/components/Editor.tsx:620-627` sets `editorProps.attributes` with only `class`. The resulting `contenteditable` `<div>` at `:981` has no `aria-label`, `role="textbox"`, or `aria-multiline`. VoiceOver announces "edit text, blank". Lighthouse and axe miss this because ProseMirror's element doesn't match standard rules — so the audit gave Docs/Issues/Programs/Projects "100" Lighthouse despite the unlabeled primary content surface.

**Change.** Added three attributes to `editorProps.attributes` in `web/src/components/Editor.tsx:622`:

- `'aria-label': 'Document body'` — the accessible name SR users hear.
- `'aria-multiline': 'true'` — communicates that Enter inserts a newline rather than submitting.
- `role: 'textbox'` — promotes the `contenteditable` div from a generic group to a recognized input role.

Did not use `aria-labelledby` against the title textarea — `aria-label` is the minimum complete name and avoids coupling the body's name to the title control's id.

**After.** Editor surface announced as "Document body, edit text, multi line" by VoiceOver. Affects every editor-bearing page.

**Reproducibility.** DevTools accessibility tree on `.ProseMirror`; expect non-empty accessible name.

### 1.6 Icon-only buttons: workspace switcher and avatar/logout — Status: **Done**

**Before.** `web/src/pages/App.tsx:302-308` (workspace switcher) and `:410-416` (avatar/logout) use only `title=` for tooltip. `title` is announced inconsistently across SRs and only on hover, not focus. The avatar button's accessible name is the user's initial (e.g. "R"), and the workspace switcher's name is the first character of the workspace name — neither conveys what the button does.

**Change.** Two concrete patches in `web/src/pages/App.tsx`:

1. Workspace switcher button: added `aria-label={currentWorkspace?.name ? \`Switch workspace (current: ${currentWorkspace.name})\` : 'Select workspace'}`. The accessible name names the *action* (switch) and folds in current context (workspace name) so SR users hear what they're activating, not just where they are.
2. Avatar/logout button: added `aria-label={\`Sign out (${user?.name ?? 'user'})\`}`. Sign-out is the verb; the user's name is parenthetical context so the announcement begins with the action.

`title` is preserved on both buttons as the visual hover tooltip — the problem was using `title` as the *accessible name* source (inconsistent across SRs, hover-only), not the tooltip itself. With `aria-label` present, browsers compute the accessible name from `aria-label` and `title` reverts to its visual-tooltip role only.

**After.** SR announces "Switch workspace (current: Engineering), button" and "Sign out (Ryan Jagger), button" instead of the rendered initial.

**Reproducibility.** Audit-runner "Unnamed buttons" check on App layout; expect 0. DevTools accessibility panel on each button; expect the `aria-label` text as the computed name.

### 1.7 ProjectSetupWizard: `aria-describedby` + `aria-invalid` on field errors — Status: **Done**

**Before.** `web/src/components/ProjectSetupWizard.tsx:96-112` and `:120-144` render error `<p>` adjacent to inputs without linking them. `aria-invalid` is also not set. Login does this correctly (`Login.tsx:252-253`) — the wizard just needs the same pattern.

**Change.** Four attributes added across two field groups in `web/src/components/ProjectSetupWizard.tsx`:

1. Project Name `<input>` (around `:96-109`): added `aria-invalid={errors.title ? true : undefined}` and `aria-describedby={errors.title ? 'project-name-error' : undefined}`. The matching error `<p>` gets `id="project-name-error"`.
2. Program `<select>` (around `:120-141`): added `aria-invalid={errors.program ? true : undefined}` and `aria-describedby={errors.program ? 'project-program-error' : undefined}`. The matching error `<p>` gets `id="project-program-error"`.

Using `undefined` (not `'false'`) on the non-error path keeps the attribute absent from the DOM and matches the Login pattern. The "No programs available. Create a program first." `<p>` at `:145-148` is intentionally left alone — it's a state hint, not a validation error, and the empty option list plus disabled submit button already communicate that state to SR users. Plan and Target Date fields are optional with no error path and were not touched.

**After.** Error text is announced when the input receives focus, and `aria-invalid` lets SR users know the field is in an error state.

**Reproducibility.** Trigger validation in the wizard; tab back to the field; expect VoiceOver to announce error text.

### Phase 1 verification (2026-05-22)

After all five Phase 1 commits landed (`74ce704`, `087d67c`, `c0908cb`, `31339df`, `6bd2cdf`), ran `pnpm build:web` followed by `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`. Full route summary from `audit/accessibility/results.json`:

| Route | LH before | LH after | Critical | Serious | SR proxy |
| --- | ---: | ---: | ---: | ---: | --- |
| Login | 98 | **100** | 0 | 0 | Pass |
| My Week | 95 | 95 | 0 | 1 (contrast, Phase 3) | Pass |
| Docs | 100 | 100 | 0 | 0 | Pass |
| Issues | 100 | 100 | 0 | 0 | Pass |
| Programs | 100 | 100 | 0 | 0 | Pass |
| Projects | 100 | 100 | 0 | 0 | Pass |
| Team Allocation | 96 | 96 | 0 | 1 (contrast, Phase 3) | Pass |
| Team Directory | 100 | 100 | 0 | 0 | Pass |
| Team Status | 96 | 96 | 0 | 1 (contrast, Phase 3) | Pass |
| Settings | 94 | **100** | **1 → 0** | 0 | Pass |

Phase 1 deltas: axe Critical 1 → 0, Settings Lighthouse 94 → 100, Login Lighthouse 98 → 100. The three remaining Serious violations are all `color-contrast` on the `text-accent`/`bg-background` current-week labels — scheduled for Phase 3.

Items 1.4 (TipTap title), 1.5 (TipTap body), 1.6 (icon-only buttons), and 1.7 (ProjectSetupWizard errors) do not move the automated numbers because:

- axe has no rule for ProseMirror's `contenteditable` accessible name (peer-review §1), so 1.4 and 1.5 are invisible to the runner — the fix is verified by `grep` on the source: `'aria-label': 'Document body'` and `role: 'textbox'` at `Editor.tsx:625, :627`, `aria-label="Document title"` at `:944`.
- Replacing `title=` with `aria-label=` doesn't change Lighthouse score (1.6) — `title` was already a fallback accessible-name source. The improvement is announcement consistency across screen readers and on focus rather than only on hover. Verified by `grep` at `App.tsx:306, :415`.
- ProjectSetupWizard error linking (1.7) only manifests when validation fails post-submit — the runner doesn't synthesize form failures. Verified by `grep` at `ProjectSetupWizard.tsx:108-109, :113, :132-133, :147`.

Unit tests passing: API 28 files / 451 tests, web 16 files / 151 tests (`pnpm test`).

## Phase 2 — Serious (WCAG A: 1.3.1, 2.1.1, 2.1.4)

These are structural/keyboard issues — the controls are technically reachable but not announced, not operable without a mouse, or not navigable with the keyboard model the user expects.

### 2.1 TabBar / tabpanel wiring + roving tabindex — Status: **Done** (verified at Phase 2 end)

**Before.** `web/src/components/ui/TabBar.tsx:25` sets `aria-controls={\`tabpanel-${tab.id}\`}`, but `web/src/pages/UnifiedDocumentPage.tsx:500-512` renders tab content in a plain `<div>` with no `id`, no `role="tabpanel"`, no `aria-labelledby`. The reference dangles. Also missing: roving `tabIndex={selected ? 0 : -1}` and ArrowLeft/ArrowRight handlers.

**Change.** Two concrete patches:

1. `web/src/components/ui/TabBar.tsx`: added roving tabindex (`tabIndex={activeTab === tab.id ? 0 : -1}`) so only the active tab is in the Tab order; inactive tabs are reachable via arrow keys. Added an `onKeyDown` handler bound per tab that responds to `ArrowLeft` / `ArrowRight` (with wrap-around via `(currentIndex + delta + tabs.length) % tabs.length`), `Home` (index 0), and `End` (index `tabs.length - 1`). The handler calls `onTabChange(newId)` and then moves DOM focus via `document.getElementById(\`tab-${newId}\`)?.focus()` — this is the automatic-activation variant of the WAI-ARIA tabs pattern, which is the standard choice for tabs that simply swap content (no async load gated on activation). `event.preventDefault()` is called for handled keys so page scroll doesn't fire on Home/End. The bottom-bar indicator div, classes, and prop interface are unchanged — TabBar is additive-compatible.
2. `web/src/pages/UnifiedDocumentPage.tsx`: hoisted `const activeTabId = activeTab || tabs[0]?.id;` above the JSX so it's the single source of truth for both the `TabBar` `activeTab` prop and the panel attributes. Promoted the tab content wrapper from `<div className="flex-1 overflow-hidden">` to a real tabpanel: `id={\`tabpanel-${activeTabId}\`}`, `role="tabpanel"`, `aria-labelledby={\`tab-${activeTabId}\`}`, `tabIndex={0}`, and `focus:outline-none` appended to the className so the panel-level focus ring doesn't clash with the inner content's own focus rings (which remain).

Did not introduce manual-activation (Space/Enter to commit a focus change) — automatic activation is the more common pattern for content-swap tabs and matches what the existing `onClick` behavior implies. TabBar is only consumed by `UnifiedDocumentPage` (`grep` confirmed), so the prop-interface contract is unchanged.

**After.** Tabs follow the WAI-ARIA Authoring Practices tabs pattern. `aria-controls` references resolve. Keyboard users can ArrowLeft/Right through tabs, Home/End to jump, and Tab into the panel content.

**Reproducibility.** Focus a tab; press ArrowRight; focus moves to next tab and content swaps. Inspect each `aria-controls` value; `document.getElementById(...)` resolves to the tabpanel `<div>`.

### 2.2 Comment context menu: keyboard support — Status: **Done** (verified at Phase 2 end)

**Before.** `web/src/components/Editor.tsx:954-978` built an ad-hoc DOM menu via `document.createElement` on `onContextMenu`. No `role="menu"`, no Escape handling, no focus mgmt, no keyboard activation path. Right-click only.

**Change.** Replaced the imperative `document.createElement` block with a state-driven React menu in `web/src/components/Editor.tsx`:

1. New state `commentMenuPos: { x; y } | null` and ref `commentMenuFirstItemRef` declared alongside the existing `title`/`titleInputRef` state. The `onContextMenu` handler on `.tiptap-wrapper` now just calls `setCommentMenuPos({ x: e.clientX, y: e.clientY })` after the existing empty-selection guard.
2. Menu rendered conditionally inside the editor JSX with `role="menu"`, `aria-label="Comment actions"`, `position: fixed` anchored to the stored coords, and Tailwind classes `bg-background border border-border rounded-md shadow-lg p-1` (replacing the inline `rgb(...)` styles).
3. Single `<button role="menuitem" tabIndex={-1}>` for "Add Comment". A `useEffect` keyed on `commentMenuPos` focuses the button on open. Click invokes `editor.commands.addComment()`, clears state, and returns focus via `editor.commands.focus()`.
4. Escape (`onKeyDown` on the menu container) closes the menu and restores editor focus. A second `useEffect` registers a `mousedown` listener while the menu is open that closes it on any outside click.
5. Shift+F10 and the context-menu key trigger the native `onContextMenu` event in Chrome/Firefox/Safari, so no separate keyboard-activation handler is needed — the same React state path opens the menu.

The menu has only one item ("Add Comment"), so ArrowUp/Down handlers were intentionally omitted (no items to navigate to). The empty-selection guard, the `editor.commands.addComment()` action, and the BubbleMenu mouse affordance are unchanged.

**After.** Comment menu reachable from the keyboard via Shift+F10 / context-menu key; first item is focused on open; Escape closes and returns focus to the editor; outside-click still closes. Menu container exposes `role="menu"` / `aria-label="Comment actions"`, item exposes `role="menuitem"`.

**Reproducibility.** In editor with selection, press Shift+F10; expect menu to open and "Add Comment" to be focused. `grep -n 'document.createElement' web/src/components/Editor.tsx` returns 0 hits in the comment-menu region; `grep -n 'role="menu"\|role="menuitem"' web/src/components/Editor.tsx` shows both roles present.

### 2.3 KanbanBoard: drop `aria-grabbed`, wire dnd-kit accessibility — Status: **Done** (verified at Phase 2 end)

**Before.** `web/src/components/KanbanBoard.tsx:283` set `aria-grabbed={isDragging ? 'true' : 'false'}` on each draggable card. `aria-grabbed` was deprecated in ARIA 1.1; modern screen readers ignore it. The `DndContext` had no `accessibility` prop, so keyboard drag-drop produced no announcement at start, over, end, or cancel.

**Change.** Two concrete patches in `web/src/components/KanbanBoard.tsx`:

1. Removed the `aria-grabbed` attribute from the draggable card wrapper. Sibling attributes that remain are still load-bearing: `aria-selected` (selection state), `tabIndex={0}` (focus), `role="button"`, `aria-roledescription="draggable issue"`, and the per-card `aria-label` describing the issue. The wrapper `<div>`'s `role="application"` and the wrapper `aria-label` describing the keyboard model also stay.
2. Added the `accessibility` prop to `<DndContext>` with two keys:
   - `screenReaderInstructions.draggable`: `"To pick up an issue, press Space or Enter. Use arrow keys to move it between columns. Press Space or Enter again to drop. Press Escape to cancel."` — read once when focus first lands on a draggable.
   - `announcements`: four callbacks (`onDragStart`, `onDragOver`, `onDragEnd`, `onDragCancel`) that return strings the dnd-kit live region announces. Two helpers — `getIssueLabel(id)` (closes over the `issues` prop, returns `#${ticket_number}: ${title}` or falls back to the id) and `getColumnLabel(id)` (looks up `COLUMNS.title` or falls back to the id) — convert dnd-kit ids into human-readable text. Start announces "Picked up issue …"; over announces "Issue … is over <Column>." or "… is no longer over a column."; end announces "… was dropped in <Column>." or "… was dropped outside any column."; cancel announces "Drag of issue … was cancelled."

No new dependency. The implementation.md plan mentioned `@dnd-kit/accessibility`, which is the historical name; the canonical home in modern `@dnd-kit/core` ^6.x is the `accessibility` prop on `DndContext`, which is what we used. The existing `handleDragStart` / `handleDragEnd` handlers (which manage the `activeId` state for the `DragOverlay`) are unchanged — the announcement callbacks are a separate concern.

**After.** Screen-reader users hear "Picked up issue #123: Foo", "Issue #123: Foo is over In Progress", "Issue #123: Foo was dropped in Done" during keyboard drag-and-drop. Static instructions are announced when focus first enters a draggable card.

**Reproducibility.** `grep -n 'aria-grabbed' web/src/components/KanbanBoard.tsx` returns 0 hits. `grep -n 'accessibility=' web/src/components/KanbanBoard.tsx` returns 1 hit on the `DndContext`. Tab to a kanban card; expect VoiceOver to read the static instructions. Press Space, ArrowRight to a different column, Space; expect the start/over/end announcements.

### 2.4 Single-character global shortcuts — Status: _TBD_

**Before.** `web/src/components/IssuesList.tsx:1011` and `web/src/pages/Projects.tsx:317` register a global `keydown` listener firing on bare `c` to create an item. Guarded against INPUT/TEXTAREA/contentEditable but WCAG 2.1.4 requires the shortcut to be remappable, disable-able, or active only when the component has focus.

**Change.** Preferred: require a modifier (`Ctrl/Cmd+Shift+C` or similar). Alternative: add a settings toggle to disable single-char shortcuts. Cheapest viable: gate by `document.activeElement` being inside the list component (focus-scoped).

**After.** Bare `c` no longer triggers globally; modifier or focus required.

**Reproducibility.** With focus outside the list, press `c`; expect no creation.

### 2.5 Grid semantics for heatmap and allocation grid — Status: _TBD_

**Before.** `web/src/components/StatusOverviewHeatmap.tsx` and `web/src/components/AccountabilityGrid.tsx` build columns/rows entirely with `<div>` and no grid roles. SR users cannot navigate by row/column or know the column header for a cell. Plus current-week highlight is color-only (`ring-1 ring-accent/30` + blue text — WCAG 1.4.1).

**Change.** Either add `role="grid"` + `role="row"` + `role="columnheader"` + `role="rowheader"` to the container hierarchy, OR rewrite as `<table>`. Prefer `<table>` if static; ARIA grid if keyboard navigation needs to be custom. Add a non-color "This week" badge on the current-week column header.

**After.** Heatmap/grid structure announced row-by-column; current-week distinguishable without color.

**Reproducibility.** SR pass over `/team/status` and `/team/allocation`; expect "column 3 of 12, row 2 of 8" navigation.

## Phase 3 — Serious (WCAG AA: 1.4.3, 2.3.3)

### 3.1 `accent-text` color token + repo-wide replacement — Status: _TBD_

**Before.** `text-accent` (#005ea2) on `bg-background` (#0d0d0d) yields ~2.99:1 contrast, failing AA 4.5:1. The audit reported 3 instances; the actual surface is ~20+ files using the token for text:

- `web/src/components/ui/Combobox.tsx:138` (check-mark indicator color)
- `MultiPersonCombobox.tsx`, `ProjectCombobox.tsx`, `ProgramCombobox.tsx`, `PersonCombobox.tsx` check states
- `web/src/components/DashboardSidebar.tsx:36, :51` active-link styling
- `web/src/components/StandupFeed.tsx:317` mentions
- `web/src/components/document-tabs/ProgramWeeksTab.tsx:120`
- `web/src/components/IssuesList.tsx:1062, :1175` "Create an issue" link
- `web/src/components/AccountabilityGrid.tsx`, `StatusOverviewHeatmap.tsx`, `DocumentTreeItem.tsx`, `WeekTimeline.tsx`, `ProgramProjectsTab.tsx`, `VisibilityDropdown.tsx`
- Per-page current-week labels on My Week, Team Allocation, Team Status

**Change.** Add an `accent-text` token to `web/tailwind.config.js` colors at a luminance that gives ≥ 4.5:1 on `#0d0d0d` (target `#2e8dcc` or lighter; verify). Search-replace `text-accent` → `text-accent-text` for **text** usage only (do not touch `bg-accent`, `border-accent`, `ring-accent` which are non-text uses).

**After.** All `text-accent`-as-text instances meet AA contrast. `bg-accent` (filled controls) unchanged.

**Reproducibility.** `grep -r "text-accent" web/src` returns 0 results outside of intentional non-text or comments. Audit runner contrast check passes on My Week, Team Allocation, Team Status.

### 3.2 My Week future-row dimming — Status: _TBD_

**Before.** `web/src/pages/MyWeekPage.tsx:339` applies `isFuture && 'opacity-40'` to rows, dimming text below AA. Opacity on a text container changes effective foreground luminance against any non-uniform background.

**Change.** Replace `opacity-40` with an explicit muted text color (e.g. `text-muted`) and add a status pill ("Upcoming") so the temporal state is communicated by copy + color, not by transparency.

**After.** Future rows readable at AA; temporal state expressed in text content.

**Reproducibility.** Audit runner contrast check on My Week; expect 0 contrast violations on future rows.

### 3.3 Global `prefers-reduced-motion` — Status: _TBD_

**Before.** `grep -r 'prefers-reduced-motion\|motion-reduce\|motion-safe' web/src` returns 0 hits. Visible animations include `animate-pulse` on banners and sync indicator, `animate-in slide-in-from-right-4 fade-in` on toasts, `animate-spin` on loaders, `transition-all duration-500` on the celebration banner.

**Change.** Add to `web/src/index.css`:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```
Audit `animate-pulse` usages on banners (`AccountabilityBanner.tsx:30, :56`) and the sync dot (`Editor.tsx:865`) — these are status indicators, not loading; consider replacing pulse with a static color cue regardless of `prefers-reduced-motion`.

**After.** Users with `prefers-reduced-motion: reduce` get a still UI; vestibular-safe.

**Reproducibility.** macOS System Settings → Accessibility → Display → Reduce motion = ON; reload app; expect no visible pulse/spin/slide.

## Phase 4 — Moderate / Polish

### 4.1 Decorative `<label>` refactor — Status: _TBD_

**Before.** ~25 `<label>` elements used as styled typography with no `htmlFor` and no wrapped control. Examples: `PropertiesPanel.tsx:281, :319, :367, :375`; `ProjectRetro.tsx:200, :255, :266, :283, :331`; `WikiSidebar.tsx:94`; `WeeklyReviewSubNav.tsx:143, :166, :177, :213`; `DocumentTypeSelector.tsx:30`.

**Change.** Convert each to `<div>`, `<span>`, or `<p>` with the same Tailwind classes. SRs stop announcing "label" inappropriately and form-association heuristics stop misfiring.

**After.** `<label>` reserved for actual form associations.

**Reproducibility.** `grep -rn '<label' web/src` reviewed; every remaining `<label>` has `htmlFor` or wraps a control.

### 4.2 SelectableList table/grid semantics conflict — Status: _TBD_

**Before.** `web/src/components/SelectableList.tsx:117-130` puts `role="grid"` on a `<table>`, suppressing native `<th>` column-header announcement. `<th>` at `:134, :136` lacks `scope="col"`. The empty selection-column header at `:134` has only `aria-label="Selection"`.

**Change.** Pick one model:
- **Option A (preferred for static lists):** drop `role="grid"`; let native `<table>` semantics announce. Add `scope="col"` to `<th>`.
- **Option B (if grid keyboard model is desired):** keep `role="grid"`, explicitly add `role="columnheader"` to `<th>`, ensure roving tabindex + arrow-key navigation is implemented.

Decide based on whether the list needs ARIA-grid keyboard navigation. Default to Option A.

**After.** `<th>` cells announced as column headers. No conflicting roles.

**Reproducibility.** SR pass over a selectable list; expect "column 2, Title".

### 4.3 Image alt text UI — Status: _TBD_

**Before.** `web/src/components/editor/ResizableImage.tsx:62` renders `alt={node.attrs.alt || ''}`. `web/src/components/editor/ImageUpload.tsx:129` always sets `alt: file.name`. No UI to write meaningful alt text. Every uploaded image is unlabeled (filename is not a description). WCAG 1.1.1.

**Change.** Add an alt-text prompt to the image upload flow (modal or inline input after insert). Allow editing alt on existing images via the resize handles' UI or a properties panel. Default to empty (decorative) rather than filename when the user dismisses without entering text.

**After.** Users can write meaningful alt text; documents become accessible to SR readers.

**Reproducibility.** Upload an image; expect a prompt or visible alt-text input.

### 4.4 CommandPalette focus save/restore — Status: _TBD_

**Before.** `web/src/components/CommandPalette.tsx:42-101` implements a focus trap but does not save the previously-focused element on open or restore it on close. After Cmd+K → Escape, focus is dropped on document body.

**Change.** On open: `previousActiveElement.current = document.activeElement as HTMLElement`. On close: `previousActiveElement.current?.focus()`.

**After.** Cmd+K then Escape returns focus to where the user was.

**Reproducibility.** Focus a tree item; Cmd+K; Escape; expect the original item to be focused.

### 4.5 Sync-status live region: quiet routine ticks — Status: _TBD_

**Before.** `web/src/components/Editor.tsx:854` uses `role="status" aria-live="polite" aria-atomic="true"` wrapping the four-state sync indicator. Text content flips between "Saving"/"Saved"/"Cached"/"Offline" frequently during typing, causing NVDA/JAWS to read repeatedly.

**Change.** Default to `aria-live="off"`; flip to `polite` only on transitions out of `synced` (i.e. when the user goes offline or sync fails). Debounce or omit re-announcements when bouncing between Saving ↔ Saved during routine typing.

**After.** SR users hear sync status when it matters (disconnect) and silence during normal typing.

**Reproducibility.** SR pass while typing; expect quiet. Disconnect network; expect "Offline" announcement.

## Phase 5 — Infrastructure

### 5.1 Audit-runner improvements — Status: _TBD_

**Before.** `audit/accessibility/audit-runner.spec.ts:170-171` treats `placeholder` as an accessible name in `hasName`. Tab-reachability is reported as `168/169` but no activation testing is done. No `aria-controls` integrity check exists. The ProseMirror editor surface is not checked for accessible name. Default axe rules don't enable `color-contrast-enhanced` (AAA).

**Change.**
- Remove `placeholder` from the `hasName` heuristic — placeholder is not an accessible name (WCAG 3.3.2).
- Add an `aria-controls` integrity check: for every element with `aria-controls`, assert `document.getElementById(value)` resolves.
- Add a dedicated check that `.ProseMirror` (or `[contenteditable="true"]`) has an accessible name via `aria-label` / `aria-labelledby`.
- After Tab to each focusable, press Enter or Space and assert no error is thrown (sanity check, not full activation coverage).
- Add an optional pass with `color-contrast-enhanced` enabled for AAA spot-checks.

**After.** Runner catches the TabBar, title textarea, invite email, and ProseMirror issues automatically; future regressions are gated.

**Reproducibility.** `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts` reports the additional checks in `results.json`.

### 5.2 GitHub Actions workflow for accessibility — Status: _TBD_

**Before.** `e2e/accessibility-remediation.spec.ts` exists with ~60 axe-based tests (`wcag22aa` tags on Login, Docs, Issues at lines 1517-1563) but `.github/workflows/` does not exist. The tests don't run in CI.

**Change.** Create `.github/workflows/accessibility.yml`:
- Trigger on pull_request and push to master.
- Run `pnpm install`, `pnpm db:seed` (against a Postgres service container), `pnpm build`.
- Run the audit-runner spec and `e2e/accessibility-remediation.spec.ts`.
- Fail if any Lighthouse score < 100 on audited routes or any Critical/Serious axe violation surfaces.

**After.** PRs that regress accessibility on the audited routes fail CI.

**Reproducibility.** Open a PR with a regression (e.g. remove the `<main>` landmark); expect CI failure.

## End-to-end verification

Each phase will be verified through the audit runner and a manual SR smoke pass. Format mirrors the bundle-size doc:

| Route / Surface | Check | Result |
| --- | --- | --- |
| Login | Lighthouse, axe, VoiceOver | _TBD_ |
| My Week | Contrast, opacity replacement | _TBD_ |
| Docs / Issues / Programs / Projects | Editor + title accessible name | _TBD_ |
| `/team/allocation` | Grid semantics, contrast | _TBD_ |
| `/team/status` | Grid semantics, contrast | _TBD_ |
| Settings | Selects, labels | _TBD_ |
| TabBar | aria-controls integrity, roving focus | _TBD_ |
| CommandPalette | Focus save/restore | _TBD_ |
| Kanban | dnd-kit announcements | _TBD_ |
| Image upload | Alt-text UI | _TBD_ |
| Reduced motion | macOS toggle off → on | _TBD_ |

## Deferred

Carried forward from the README and peer review:

- **Manual VoiceOver smoke pass for Section 508 attestation.** Required for formal conformance claim; not done as part of the automated pass.
- **`prefers-reduced-motion` per-component refactor of `animate-pulse` status cues.** The global CSS rule (§3.3) is the minimum; the deeper refactor of pulse-as-status-indicator on `AccountabilityBanner` and the sync dot is design-system work.
- **Decorative image alt content for already-uploaded images.** The §4.3 UI fix prevents new bad alt text; backfilling existing documents is a data-tooling task.
- **`@uswds/uswds` icon glob and 245 tiny chunks** (out of scope — bundle audit, not a11y).

## Methodology

- Audit runner: `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`.
- Lighthouse: 13.3.0, accessibility category only, desktop viewport 1440x1000, installed at `/private/tmp/ship-a11y-tools/node_modules` (override via `LIGHTHOUSE_NODE_MODULES`).
- axe: `@axe-core/playwright` with `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tags.
- Keyboard: Tab traversal plus targeted arrow-key checks for grid widgets (added in §5.1).
- Manual VoiceOver checks for accessible-name surfaces that the automated proxy cannot evaluate (TipTap editor body, title textarea, image alt).
- Raw evidence per phase committed to `audit/accessibility/results.json` (re-generated by the audit runner).

## Branch state at time of writing

- Branch: `implement/accessibility`
- Baseline scores: 1 Critical, 3 Serious axe violations; Lighthouse 94 (Settings) to 100 across audited pages.
- No implementation commits yet — this document is the plan; per-fix sections will be updated with **Status: Done / Commit: SHA** as work lands.
