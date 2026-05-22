# Accessibility Audit — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-19) and `peer-review.md` (reviewer pass, supersedes the README's findings list). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/accessibility`.

The audit and peer review together identified 4 originally-flagged violations plus ~20 issues that the automated Lighthouse + axe pass missed. This document tracks remediation in five phases, ordered by WCAG severity and blast radius.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| Lighthouse low-water-mark (Settings) | 94 | **100** | `087d67c` |
| Login Lighthouse | 98 | **100** | `74ce704` |
| axe Critical violations | 1 | **0** | `087d67c` |
| axe Serious violations | 3 | **0** | `bd39119` |
| Lighthouse all-route low-water-mark | 94 | **100** | `bd39119` |
| Pages with `<main>` landmark | 9/10 (Login missing) | **10/10** | `74ce704` |
| Selects missing accessible name | 3 (Settings) | **0** | `087d67c` |
| `text-accent` on `bg-background` text usages | ~20+ | **0** (43 files, 76 substitutions → `text-accent-text`) | `bd39119` |
| Opacity-based text dimming (`opacity-40` on rows) | 1 (My Week future rows) | **0** | `754d398` |
| TipTap surfaces with accessible name | 0 (body + title) | **2/2** | `c0908cb` |
| Icon-only buttons relying on `title` for SR name | 2 (workspace, sign-out) | **0** | `31339df` |
| Form fields with linked validation errors | 2 (Login only) | **4** (+ ProjectSetupWizard) | `6bd2cdf` |
| Tab panels with valid `aria-controls` target | 0 (dangling refs) | _Phase 2_ | — |
| Reduced-motion handling | None | **Global CSS rule (4 declarations, universal selector)** | `f361196` |
| `aria-grabbed` (deprecated) usages | 1 | **0** (replaced by dnd-kit announcements) | _Phase 2_ |
| Single-character global keyboard shortcuts | 2 (`c` on Issues, Projects) | **0** (now Shift+C) | `50eeb37` |
| Color-only current-week marker on grids | 2 (heatmap, allocation) | **0** (sr-only label + aria-current added) | _Phase 2_ |
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

### 2.4 Single-character global shortcuts — Status: **Done** (verified at Phase 2 end)

**Before.** `web/src/components/IssuesList.tsx:1011` and `web/src/pages/Projects.tsx:317` registered a global `keydown` listener firing on bare `c` to create an item. Guarded against INPUT/TEXTAREA/contentEditable but WCAG 2.1.4 requires single-character shortcuts to be turn-off-able, remappable, or active only when the component has focus. None of those three remedies applied.

**Change.** Added the Shift modifier to the trigger in both files — bare `c` → `Shift+C`. With a modifier present, the keystroke is no longer a "single character" per WCAG 2.1.4's wording, so the rule no longer applies. This is the cheapest of the three valid remedies (modifier vs. turn-off-able vs. focus-scoped) and doesn't introduce new state, refs, or a settings UI.

Two concrete patches, identical pattern:

1. `web/src/components/IssuesList.tsx:1011`: `e.key === 'c' && !e.metaKey && !e.ctrlKey && canCreateIssue` → `e.key === 'C' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && canCreateIssue`.
2. `web/src/pages/Projects.tsx:317`: `e.key === 'c' && !e.metaKey && !e.ctrlKey` → `e.key === 'C' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey`.

`e.key === 'C'` (capital) is the correct match because Shift+C produces the uppercase character. The explicit `!e.metaKey && !e.ctrlKey && !e.altKey` guards prevent the handler from firing on `Cmd+Shift+C`, `Ctrl+Shift+C`, or `Alt+Shift+C` — common browser/system shortcuts (e.g. Chrome's "Inspect Element"). The existing INPUT/TEXTAREA/contentEditable focus guard is unchanged.

No visible UI documented the old `c` shortcut (no tooltips, no help text — `grep` confirmed), so no label updates were needed.

**After.** Bare `c` no longer triggers creation; Shift+C does. WCAG 2.1.4 inapplicable.

**Reproducibility.** Focus the list area; press `c` — expect no creation. Press `Shift+C` — expect the create-item flow. `grep -n "e.key === 'c'" web/src/components/IssuesList.tsx web/src/pages/Projects.tsx` returns 0 hits; `grep -n "e.key === 'C'" web/src/components/IssuesList.tsx web/src/pages/Projects.tsx` returns 1 hit per file.

### 2.5 Grid semantics for heatmap and allocation grid — Status: **Partially Done** (verified at Phase 2 end)

**Before.** `web/src/components/StatusOverviewHeatmap.tsx` and `web/src/components/AccountabilityGrid.tsx` build columns/rows entirely with `<div>` and no grid roles. SR users cannot navigate by row/column or know the column header for a cell. Plus current-week highlight is color-only (`ring-1 ring-accent/30` + blue text — WCAG 1.4.1).

**Change.** Two concrete fixes landed; the full ARIA-table treatment was deferred. Patches in `web/src/components/StatusOverviewHeatmap.tsx` and `web/src/components/AccountabilityGrid.tsx`:

1. Current-week / current-sprint header: added an `<span className="sr-only">Current week — </span>` (heatmap) / `Current sprint — ` (allocation) prefix inside the existing text span on the header `<div>`, rendered only when `week.isCurrent` / `sprint.isCurrent` is true. Added `aria-current="date"` to the same header `<div>` on the current column. This converts the WCAG 1.4.1 color-only signal (blue `text-accent` + `ring-accent/30`) into color + text + ARIA state.
2. Outer container: added `role="region"` and `aria-label="Team status heatmap — rows are programs and people, columns are weeks"` to the `StatusOverviewHeatmap` outermost rendering `<div>` (the `flex h-full flex-col` wrapper). Same treatment on `AccountabilityGrid`'s `scrollContainerRef` div with label `"Team accountability grid — rows are projects within programs, columns are sprints"`. The descriptive `aria-label` gives SR users the structural orientation that a proper `role="table"` would normally provide, without requiring DOM restructuring.

Full ARIA table semantics (`role="grid"` / `role="row"` / `role="columnheader"` / `role="rowheader"`) were NOT applied. Reason: both components render **column-major** — the DOM is a sticky left-column of row labels next to a flex row of week/sprint columns, where each week column is a vertical stack of (header on top + per-row cells below). The visual rows in the table emerge from CSS layout, not from DOM order. Adding `role="row"` / `role="rowheader"` to that DOM would describe each *column* as a "row" to SR users (who read DOM order, not visual order), which is worse than no role at all. A faithful row-major mapping requires rewriting the JSX so cells for a given row are siblings; that's a substantial refactor on complex visualization components with sticky columns, virtual-scroll considerations, and per-cell click handlers, out of scope for this fix.

**After.** WCAG 1.4.1 color-only current-week signal is resolved: the temporal state is now communicated by color + sr-only text + `aria-current="date"`. The outer `role="region"` + descriptive `aria-label` gives SR users a discoverable landmark and structural orientation when entering the visualization. Full row-by-column grid navigation (announce "column 3 of 12, row 2 of 8") is deferred — tracked in **Deferred**.

**Reproducibility.** `grep -n 'aria-current' web/src/components/StatusOverviewHeatmap.tsx web/src/components/AccountabilityGrid.tsx` returns 1 hit per file. `grep -n 'role="region"' web/src/components/StatusOverviewHeatmap.tsx web/src/components/AccountabilityGrid.tsx` returns 1 hit per file. `grep -n 'sr-only.*current' web/src/components/StatusOverviewHeatmap.tsx web/src/components/AccountabilityGrid.tsx` (case-insensitive) returns 1 hit per file. SR pass on `/team/status` and `/team/allocation` should announce "Current week — W22" (or similar) on the highlighted column header.

### Phase 2 verification (2026-05-22)

After all Phase 2 commits landed (`cf1bc3b`, `407f81b`, `485b592`, `50eeb37`, `f77cbdf`, `e04eac8`), ran `pnpm build:web` followed by `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`. Route summary from `audit/accessibility/results.json` (unchanged from Phase 1 end — these fixes are structural/keyboard, outside Lighthouse/axe automated coverage):

| Route | LH | Critical | Serious | SR proxy |
| --- | ---: | ---: | ---: | --- |
| Login | 100 | 0 | 0 | Pass |
| My Week | 95 | 0 | 1 (color-contrast, Phase 3) | Pass |
| Docs / Issues / Programs / Projects | 100 | 0 | 0 | Pass |
| Team Allocation | 96 | 0 | 1 (color-contrast, Phase 3) | Pass |
| Team Directory | 100 | 0 | 0 | Pass |
| Team Status | 96 | 0 | 1 (color-contrast, Phase 3) | Pass |
| Settings | 100 | 0 | 0 | Pass |

Phase 2 deltas in the automated numbers: none. This is expected — the five fixes target keyboard navigation, structural ARIA, and screen-reader announcement, all of which are outside the rule coverage of axe and Lighthouse's accessibility category:

- **2.1 TabBar roving tabindex + tabpanel attributes** — axe's `aria-valid-attr-value` doesn't dereference `aria-controls` ids; the dangling reference passed automated checks even pre-fix. Verified by `grep` at `TabBar.tsx:44, :46` (roving tabindex + onKeyDown) and `UnifiedDocumentPage.tsx:503-505` (panel attributes).
- **2.2 Comment context menu** — the imperative DOM menu was invisible to axe (created on-demand outside the render tree); the React menu is verified by `grep` at `Editor.tsx:189` (state hook), `:987` (`role="menu"`), `:1001` (`role="menuitem"`).
- **2.3 KanbanBoard announcements** — `aria-grabbed` removal eliminates a deprecated-ARIA warning that axe doesn't flag at the Serious level. The `accessibility` prop's announcements are live-region behavior, not static attributes. Verified by `grep` at `KanbanBoard.tsx:164` (`screenReaderInstructions`), `:175` (`accessibility={{...}}`).
- **2.4 Shift+C shortcut** — WCAG 2.1.4 has no automated axe rule. Verified by `grep` at `IssuesList.tsx:1011` and `Projects.tsx:317` (`e.key === 'C' && e.shiftKey`).
- **2.5 Grid sr-only marker + region landmarks** — `aria-current="date"` and `role="region"` are valid attributes that axe accepts unconditionally. WCAG 1.4.1 (color-only signal) has no automated axe rule that detects context-specific color reliance. Verified by `grep` at `StatusOverviewHeatmap.tsx:313, :406` and `AccountabilityGrid.tsx:171, :285`.

The three remaining Serious violations are all `color-contrast` on the `text-accent`/`bg-background` current-week labels (My Week, Team Allocation, Team Status) — Phase 3 territory.

Unit tests passing: API 28 files / 451 tests, web 16 files / 151 tests.

## Phase 3 — Serious (WCAG AA: 1.4.3, 2.3.3)

### 3.1 `accent-text` color token + repo-wide replacement — Status: **Done** (verified at Phase 3 end)

**Before.** `text-accent` (#005ea2) on `bg-background` (#0d0d0d) yields ~2.99:1 contrast, failing AA 4.5:1. The audit reported 3 instances; the actual surface was 43 files / 76 occurrences using the token for text:

- `web/src/components/ui/Combobox.tsx:138` (check-mark indicator color)
- `MultiPersonCombobox.tsx`, `ProjectCombobox.tsx`, `ProgramCombobox.tsx`, `PersonCombobox.tsx` check states
- `web/src/components/DashboardSidebar.tsx:36, :51` active-link styling
- `web/src/components/StandupFeed.tsx:317` mentions
- `web/src/components/document-tabs/ProgramWeeksTab.tsx:120`
- `web/src/components/IssuesList.tsx:1062, :1175` "Create an issue" link
- `web/src/components/AccountabilityGrid.tsx`, `StatusOverviewHeatmap.tsx`, `DocumentTreeItem.tsx`, `WeekTimeline.tsx`, `ProgramProjectsTab.tsx`, `VisibilityDropdown.tsx`
- Per-page current-week labels on My Week, Team Allocation, Team Status

**Change.** Two pieces:

1. Added `'accent-text': '#4a9eda'` to the `colors` extend block in `web/tailwind.config.js`, sandwiched between `'accent-hover'` and `warning`. Verified contrast ratio: `#4a9eda` (L_fg ≈ 0.282) on `#0d0d0d` (L_bg ≈ 0.0029) ≈ **6.27:1** — comfortably above WCAG AA's 4.5:1 with headroom for future background tweaks. Annotated inline (`// AA-compliant accent for text (#4a9eda on #0d0d0d ≈ 6.3:1)`) since the contrast budget is non-obvious from the hex alone.
2. Repo-wide find-and-replace across `web/src/**/*.{ts,tsx}`: `text-accent` (matched only when not followed by `-` or a word character, via Perl negative lookahead) → `text-accent-text`. Touched **43 files / 76 occurrences**. Compound tokens were preserved: `text-accent-foreground` (2 hits in `MentionList.tsx`, `EmojiList.tsx`) was excluded by the lookahead and is unchanged.

**Option A (blanket replacement) was chosen over Option B (selective replacement on dark surfaces only).** Rationale: single source of truth — the codebase now uses one token for accent-colored text and that token is AA-compliant against every audited surface; mechanical sweep with no per-call-site background analysis; the new `#4a9eda` still reads as "accent blue" (lighter shade of the same hue), so testers will not perceive a brand crisis. Selective replacement would have required ~200 lines of per-component judgment calls about background context and locked in two parallel accent-text tokens to maintain forever.

`bg-accent` (filled controls / chip backgrounds), `border-accent` (borders / focus rings), `ring-accent` (focus ring color), and `accent-hover` (button hover state) were intentionally **not** touched. Those are non-text usages where the deeper brand blue still reads correctly against the surfaces they sit on, and the original brand-blue accent is preserved as the surface/chrome color.

**After.** All `text-accent`-as-text instances meet AA contrast. Brand surfaces (`bg-accent` filled chips, `border-accent` borders, focus rings) are unchanged.

**Reproducibility.** `grep -rnE 'text-accent(?![-A-Za-z_])' web/src -P` returns 0 results. `grep -rn 'text-accent-text' web/src` returns 76 hits. `grep -rn 'text-accent-foreground' web/src` returns 2 hits (preserved). Audit runner contrast check expected to pass on My Week, Team Allocation, Team Status at Phase 3 end.

### 3.2 My Week future-row dimming — Status: **Done** (verified at Phase 3 end)

**Before.** `web/src/pages/MyWeekPage.tsx:339` applied `isFuture && 'opacity-40'` to the standup-slot row. Opacity on a text container drops effective foreground luminance against the page background regardless of the text color used, pushing every child text node below AA's 4.5:1 threshold. The same future-row branch rendered "Upcoming" as italic body text inside the row's main content slot, so the only signal that a row was a future day was the opacity dimming itself.

**Change.** Two concrete patches in `web/src/pages/MyWeekPage.tsx`:

1. Row class: replaced `isFuture && 'opacity-40'` with `isFuture && 'text-muted'` at `:339`. `text-muted` (`#8a8a8a`) is already audited at 5.1:1 on `bg-background` (`#0d0d0d`) per the comment in `web/tailwind.config.js`, so future rows still read as de-emphasized but every descendant text node stays above AA. The `text-muted` cascades to the date label, weekday, and pill content because none of those children set their own color in the future-row branch (the `isToday ? 'text-accent' : 'text-muted'` branch on the date label still hard-codes the non-future case, which is fine — Phase 3.1 will retune `text-accent`).
2. Future-row body: removed the italic `<span className="text-xs text-muted italic">Upcoming</span>` from the main content flex slot and replaced it with a small pill — `<span className="rounded-full bg-border/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">Upcoming</span>` — placed inside the row immediately after the date label and before a now-empty `flex-1` spacer. The pill styling mirrors the existing chip pattern at `web/src/components/ui/MultiAssociationChips.tsx:110` and `WeekPlanningTab.tsx:144` (`rounded-full px-2 py-0.5 text-xs font-medium`), tightened one step (`text-[10px]`) so the pill reads as a status marker rather than a primary content chunk. Temporal state is now communicated by both colour de-emphasis and explicit text content, satisfying WCAG 1.4.1 (use of color) for this row.

Did not touch the `isToday ? 'text-accent' : 'text-muted'` ternary on the date label at `:345` — `text-accent` on `bg-background` is the broader Phase 3.1 swap and keeping it out of this commit scopes the diff.

**After.** Future-day standup rows on My Week read with `text-muted` (5.1:1 on `bg-background`) for visual de-emphasis instead of `opacity-40` (≈2.0:1 effective), and the "Upcoming" pill makes the temporal state explicit text rather than purely a visual cue. `grep -n 'opacity-40' web/src/pages/MyWeekPage.tsx` returns 0 hits.

**Reproducibility.** Audit runner contrast check on My Week after Phase 3 (`pnpm build:web` + `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`); expect 0 contrast violations on future-row text. Manual: load `/my-week` with a future day in view; verify the "Upcoming" pill is visible and the row text is muted but legible.

### 3.3 Global `prefers-reduced-motion` — Status: **Done** (verified at Phase 3 end)

**Before.** `grep -r 'prefers-reduced-motion\|motion-reduce\|motion-safe' web/src` returns 0 hits. Visible animations include `animate-pulse` on banners and sync indicator (~15 usages), `animate-in slide-in-from-right-4 fade-in` on toasts, `animate-spin` on loaders, `transition-all duration-500` on the celebration banner. For users with `prefers-reduced-motion: reduce` set in their OS, none of these were suppressed — a vestibular-disorder accessibility gap per WCAG 2.3.3.

**Change.** Appended a single global CSS rule at the bottom of `web/src/index.css` (after the existing custom rules) wrapped in `@media (prefers-reduced-motion: reduce)`, targeting `*, *::before, *::after` with four declarations:

- `animation-duration: 0.01ms !important` — effectively collapses animations to a single frame so they "complete" without motion.
- `animation-iteration-count: 1 !important` — ensures infinite animations (e.g. `animate-pulse`, `animate-spin`) don't loop.
- `transition-duration: 0.01ms !important` — snaps CSS transitions instantly instead of interpolating.
- `scroll-behavior: auto !important` — overrides any smooth-scroll behavior elsewhere; sudden but correct for users who opted out of motion.

`!important` is required to override Tailwind's utility-class specificity. The universal selector `*, *::before, *::after` is the WAI-ARIA Authoring-Practices recommended pattern and matches the precedent used by Tailwind UI, GitHub Primer, and GitLab Pajamas. A one-line comment (`/* WCAG 2.3.3 reduced-motion: snap all animations + transitions */`) sits above the rule because the intent isn't obvious from the syntax alone.

The peer review (§8) notes that `animate-pulse` is also used as a *status indicator* on the AccountabilityBanner warning icon (`AccountabilityBanner.tsx:56`) and the syncing dot in Editor (`Editor.tsx:885`). Replacing pulse-as-status with a non-pulse cue (e.g. a static color or icon) is a design-system call that's deferred — listed in the **Deferred** section. The global CSS rule covers the WCAG 2.3.3 conformance ask without that per-component refactor.

Did NOT gate individual animations in TSX (no per-call-site `motion-safe:`/`motion-reduce:` Tailwind variants, no `useReducedMotion` hooks). The single CSS rule catches every animation and transition in the app today, and any future ones, without an audit.

**After.** With the rule in place, users with `prefers-reduced-motion: reduce` get a still UI: `animate-pulse`, `animate-spin`, `animate-in slide-in-from-right`, `transition-all duration-500`, and every other animated or transitioned property snap to instant. WCAG 2.3.3 satisfied.

**Reproducibility.** `grep -n 'prefers-reduced-motion' web/src/index.css` returns 1 hit; `grep -rn 'prefers-reduced-motion' web/src` returns just the index.css hit (no orphan rules elsewhere). Manual: macOS System Settings → Accessibility → Display → Reduce motion = ON; reload app; expect no visible pulse/spin/slide on AccountabilityBanner, toasts, loaders, or the celebration banner.

### Phase 3 verification (2026-05-22)

After all Phase 3 commits landed (`754d398`, `3257cbc`, `bd39119`, `f361196`), ran `pnpm build:web` followed by `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`. Route summary from `audit/accessibility/results.json`:

| Route | LH before | LH after | Critical | Serious |
| --- | ---: | ---: | ---: | ---: |
| Login | 100 | **100** | 0 | 0 |
| My Week | 95 | **100** | 0 | **1 → 0** |
| Docs | 100 | **100** | 0 | 0 |
| Issues | 100 | **100** | 0 | 0 |
| Programs | 100 | **100** | 0 | 0 |
| Projects | 100 | **100** | 0 | 0 |
| Team Allocation | 96 | **100** | 0 | **1 → 0** |
| Team Directory | 100 | **100** | 0 | 0 |
| Team Status | 96 | **100** | 0 | **1 → 0** |
| Settings | 100 | **100** | 0 | 0 |

**Every audited route now scores Lighthouse 100. axe Critical: 0. axe Serious: 0.**

Phase 3 deltas:
- **3.1 `text-accent` → `text-accent-text` token replacement** is the primary driver of the cleared contrast violations. 43 TSX files and 76 substitutions; new `accent-text` token (`#4a9eda`) verified at ≈6.27:1 contrast on `#0d0d0d`. My Week, Team Allocation, and Team Status current-week labels now meet AA. Each of those three routes also picked up the Lighthouse points the contrast violations were costing.
- **3.2 My Week opacity → `text-muted` + "Upcoming" pill** removes the per-row contrast drop on future days and adds a non-color temporal signal. Not visible in axe (the runner doesn't compute container-opacity-derived contrast), but verified by `grep`.
- **3.3 `prefers-reduced-motion` global CSS rule** addresses WCAG 2.3.3; not visible in axe (no automated rule for vestibular safety), but verified by `grep` at `web/src/index.css:1034`. Manual: macOS Reduce motion ON, reload — confirmed `animate-pulse` / `animate-spin` snap still.

Unit tests passing: API 28 files / 451 tests, web 16 files / 151 tests.

## Phase 4 — Moderate / Polish

### 4.1 Decorative `<label>` refactor — Status: _TBD_

**Before.** ~25 `<label>` elements used as styled typography with no `htmlFor` and no wrapped control. Examples: `PropertiesPanel.tsx:281, :319, :367, :375`; `ProjectRetro.tsx:200, :255, :266, :283, :331`; `WikiSidebar.tsx:94`; `WeeklyReviewSubNav.tsx:143, :166, :177, :213`; `DocumentTypeSelector.tsx:30`.

**Change.** Convert each to `<div>`, `<span>`, or `<p>` with the same Tailwind classes. SRs stop announcing "label" inappropriately and form-association heuristics stop misfiring.

**After.** `<label>` reserved for actual form associations.

**Reproducibility.** `grep -rn '<label' web/src` reviewed; every remaining `<label>` has `htmlFor` or wraps a control.

### 4.2 SelectableList table/grid semantics conflict — Status: **Done**

**Before.** `web/src/components/SelectableList.tsx:117-130` puts `role="grid"` on a `<table>`, suppressing native `<th>` column-header announcement. `<th>` at `:134, :136` lacks `scope="col"`. The empty selection-column header at `:134` has only `aria-label="Selection"`.

**Change.** Took **Option B** (keep `role="grid"`, add explicit columnheader roles) because the list already has full arrow-key navigation: `web/src/hooks/useSelection.ts:254-352` handles `ArrowUp` / `ArrowDown` to move the focused row, which is genuine grid keyboard behavior. Switching to Option A (drop `role="grid"`) would mean either losing the keyboard model or having a `<table>` that announces as a passive table but behaves like a grid — also misleading.

Concrete edits at `web/src/components/SelectableList.tsx:134-138`: added `scope="col" role="columnheader"` to both the empty selection-column `<th>` and each data-column `<th>`. The explicit `role="columnheader"` is needed because `role="grid"` on the parent `<table>` would otherwise suppress native `<th>` header announcement.

**After.** Column headers announce correctly under `role="grid"`; the arrow-key keyboard model is preserved. The empty selection column still gets its accessible name from `aria-label="Selection"` (unchanged), now with a proper columnheader role.

**Reproducibility.** `grep -n 'scope="col" role="columnheader"' web/src/components/SelectableList.tsx` returns 2 hits. SR pass over `/docs` or `/issues` (which use `SelectableList`): expect "column N, <label>" when moving across cells.

### 4.3 Image alt text UI — Status: **Done**

**Before.** `web/src/components/editor/ResizableImage.tsx:62` renders `alt={node.attrs.alt || ''}`. `web/src/components/editor/ImageUpload.tsx:129` always sets `alt: file.name`. No UI to write meaningful alt text. Every uploaded image is unlabeled (filename is not a description). WCAG 1.1.1.

**Change.** Two concrete edits:

1. `ImageUpload.tsx:127`: changed `alt: file.name` to `alt: ''` on the inserted image. Filename is never a useful description (e.g. `IMG_2034.png`); empty alt is the correct default per WCAG 1.1.1 (treat the image as decorative until the author writes a real description). The `title` attribute still carries the filename for visual hover.
2. `ResizableImage.tsx`: added an inline alt-text input that appears below the image when it is selected in the editor (mirroring the existing "selected" UI surface where the resize handle already lives). The input is bound via TipTap's `updateAttributes({ alt })`, so edits persist into the document's TipTap JSON. Placeholder text "Describe this image for screen readers (leave blank if decorative)" tells authors what's expected.

The chosen surface (selected-state inline input) avoids interrupting the upload flow with a blocking `prompt()` dialog while still making alt text a one-click affordance on every image.

**After.** Authors can write meaningful alt text without leaving the editor. Existing images can be re-described by selecting them. New uploads default to empty alt rather than filename, so they are at least valid "decorative" (better than misleading SR users with a filename announcement).

**Reproducibility.** Upload an image into a document. Click the image; expect the alt-text input to appear below. Type a description; reload; expect the description to persist.

### 4.4 CommandPalette focus save/restore — Status: **Done**

**Before.** `web/src/components/CommandPalette.tsx` implemented a focus trap but did not save the previously-focused element on open or restore it on close. After Cmd+K → Escape, focus was dropped on the document body.

**Change.** Added a `previousActiveElementRef` and a small `useEffect` that runs on the `open` transition: when `open` becomes `true`, snapshot `document.activeElement`; when `open` becomes `false`, call `.focus()` on the snapshotted element and clear the ref. The effect is registered before the existing focus-trap effect so the snapshot is taken before the trap's `focusin` listener moves focus into the dialog.

**After.** Cmd+K → Escape restores focus to whatever the user was on (tree item, button, etc.). Eliminates the "focus on body" trap that screen-reader / keyboard-only users hit after dismissing the palette.

**Reproducibility.** Focus a tree item or button; press Cmd+K; press Escape; expect the original element to be re-focused (visible focus ring returns).

### 4.5 Sync-status live region: quiet routine ticks — Status: **Done**

**Before.** `web/src/components/Editor.tsx:854` uses `role="status" aria-live="polite" aria-atomic="true"` wrapping the four-state sync indicator. Text content flips between "Saving"/"Saved"/"Cached"/"Offline" frequently during typing, causing NVDA/JAWS to read repeatedly.

**Change.** Made `aria-live` conditional on the effective status: `polite` only when the status is `disconnected` or `cached` (i.e. the user has lost the live connection); `off` for `synced` and `connecting`, which are the two states that churn during routine typing. The visible indicator still updates in all four states; only the screen-reader announcement is gated. Implementation is a single line: `aria-live={isDegraded ? 'polite' : 'off'}` with `isDegraded` derived from `effectiveStatus`.

**After.** Screen readers stay silent while the user types and the editor cycles Saving ↔ Saved. They hear "Cached" or "Offline" when the user actually loses sync, which is the announcement that matters. `aria-atomic="true"` is preserved so the whole region reads as one phrase when it does announce.

**Reproducibility.** SR pass while typing (synced state); expect no announcement. Disconnect the network; expect "Offline" to be read once.

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
- **Row-major rendering rewrite of `StatusOverviewHeatmap` and `AccountabilityGrid` to support full ARIA table semantics.** Why deferred: both components render column-major (each week/sprint is a vertical DOM stack of header + per-row cells), so `role="row"` mapping would mislead SR users without a DOM restructure. The restructure is a substantial refactor on complex visualization components with sticky columns, virtual scroll considerations, and per-cell click handlers; out of scope for the audit-remediation pass. The §2.5 fix lands the WCAG 1.4.1 (color-only) and landmark/orientation pieces; full row-by-column SR navigation remains future work.
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
