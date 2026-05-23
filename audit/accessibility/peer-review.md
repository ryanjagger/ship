# Accessibility Audit - Peer Review

Reviewer pass over `audit/accessibility/README.md` and the `audit-runner.spec.ts` runner. Focus is on what an automated Lighthouse + axe scan plus a Tab traversal cannot see, plus a few places where the original audit understates severity.

## What the original audit got right

- The four violations it surfaces are real:
  - Settings member-role select missing accessible name (`web/src/pages/WorkspaceSettings.tsx:324`, also `:420`, also `:601` for token expiry — the audit calls out 324 and 420 implicitly; 601 has a `<label>` but it is unlinked, see below).
  - `text-accent` (#005ea2) on `bg-background` (#0d0d0d) on My Week / Team Allocation / Team Status current-week labels. Math: L_fg ≈ 0.108, L_bg ≈ 0.0029, ratio ≈ 2.99:1. Fails AA for normal text (4.5:1).
  - Login page is missing a `<main>` landmark (Login renders straight `<div>`s at `web/src/pages/Login.tsx:181`; only AppLayout wraps in `<main id="main-content">` at `web/src/pages/App.tsx:541`).
  - Opacity-based dimming hiding text on future rows: `web/src/pages/MyWeekPage.tsx:339` (`isFuture && 'opacity-40'`) and `:339` "Upcoming" copy.
- Good infrastructure: skip link (`App.tsx:264-269`), `useFocusOnNavigate` (`web/src/hooks/useFocusOnNavigate.ts`) moving focus + setting document.title on route change, `:focus-visible` outline in `web/src/index.css:27-30`, `text-muted` raised to #8a8a8a for 5.1:1.
- The audit recommendation to gate CI on Lighthouse + axe is well-placed because no GitHub Actions workflows exist (`.github/workflows/` directory is absent).

## Significant gaps the audit missed

### 1. The TipTap editor surface is unlabeled (every doc page)

`web/src/components/Editor.tsx:620-627` configures `editorProps.attributes` with only a `class`. The `EditorContent` rendered at `:981` ends up as a `contenteditable` `<div>` with no `aria-label`, `aria-labelledby`, or `role="textbox"`. Lighthouse and axe don't flag this because the ProseMirror element doesn't match any standard rule, but VoiceOver announces "edit text, blank" with no context. Since Docs/Issues/Projects/Programs all wrap this editor, this affects every primary audited page and the audit still gave Docs/Issues/Programs/Projects "100" Lighthouse scores. WCAG 4.1.2.

Fix: pass `attributes: { 'aria-label': 'Document body', 'aria-multiline': 'true', role: 'textbox' }` (or `aria-labelledby` pointing at the title textarea's id).

### 2. The "title" h1 and the editable title textarea are duplicated

`web/src/components/Editor.tsx:843` renders an `<h1>` showing the title in the compact header bar (`text-sm`), while `:927-949` renders the visually large editable title as a `<textarea>` with placeholder "Untitled". Screen readers hear the page heading at small visual size, while the obvious-looking title input is just a textarea with no accessible name (no `<label>`, no `aria-label`, no `aria-labelledby`). This is the most-used control in the app and the audit's "screen-reader proxy" passed it because the proxy treats a placeholder as a name.

WCAG 2.4.6 / 4.1.2. Recommendation: give the textarea `aria-label="Document title"`, and consider promoting it to the `<h1>` (drop the duplicate small-text h1).

### 3. The custom comment context menu in the editor is mouse-only

`web/src/components/Editor.tsx:954-978` builds an ad-hoc DOM menu via `document.createElement` on `onContextMenu`. It has no `role="menu"`, no Escape handling, no focus management, no keyboard activation path. Right-click is the only way to invoke it. WCAG 2.1.1 (Keyboard).

### 4. `aria-controls` on tabs points at IDs that don't exist

`web/src/components/ui/TabBar.tsx:25` sets `aria-controls={`tabpanel-${tab.id}`}`, but `web/src/pages/UnifiedDocumentPage.tsx:500-512` renders the tab content in a plain `<div>` with no `id`, no `role="tabpanel"`, and no `aria-labelledby`. The reference dangles. Also missing: roving tabindex (`tabIndex={selected ? 0 : -1}`) and ArrowLeft/ArrowRight handlers. WCAG 4.1.2 + WAI-ARIA Authoring Practices for the tabs pattern.

### 5. Team Status heatmap and Team Allocation grid are unsemantic

Both `web/src/components/StatusOverviewHeatmap.tsx` and `web/src/components/AccountabilityGrid.tsx` build column/row layouts entirely with `<div>` and zero `role="grid"`, `role="row"`, `role="columnheader"`, or `role="rowheader"`. A screen-reader user cannot navigate by row or column or know the column header for a given cell. The audit gave Team Status / Team Allocation 96 Lighthouse and called this out only as a contrast issue — the heatmap data structure itself is invisible to AT. WCAG 1.3.1.

### 6. Single-character keyboard shortcuts violate 2.1.4

`web/src/components/IssuesList.tsx:1011` and `web/src/pages/Projects.tsx:317` both register a global `keydown` listener that fires on bare "c" to create an item. They guard for INPUT/TEXTAREA/contentEditable, but WCAG 2.1.4 requires the shortcut to be remappable, disable-able, or active only when the component has focus. None of those is offered. Speech-to-text users who say "create" can trigger this.

### 7. `aria-grabbed` is deprecated

`web/src/components/KanbanBoard.tsx:283`. ARIA 1.1 deprecated `aria-grabbed` and `aria-dropeffect`; use the dnd-kit live region pattern (`@dnd-kit/accessibility` exports `LiveRegion` and `Announcements`). The current SR experience for drag-and-drop is undefined.

### 8. No `prefers-reduced-motion` honored anywhere

`grep -r 'prefers-reduced-motion\|motion-reduce\|motion-safe' web/src` returns zero results. The app has visible animations including:
- `animate-pulse` on the accountability banner warning icon (`web/src/components/AccountabilityBanner.tsx:56`)
- `animate-pulse` on the syncing dot in the document header (`web/src/components/Editor.tsx:865`)
- `animate-in slide-in-from-right-4 fade-in` on toasts (`web/src/components/ui/Toast.tsx:73`)
- `animate-spin` on loading indicators (`web/src/components/ActionItemsModal.tsx:211`, `web/src/components/PlanQualityBanner.tsx:268`)
- `transition-all duration-500` on the celebration banner (`AccountabilityBanner.tsx:30`)

WCAG 2.3.3 / Success Criterion 2.3.3 (AAA, but commonly treated as AA-adjacent for vestibular safety).

### 9. Title-only icon buttons are not keyboard-focus visible

`web/src/pages/App.tsx:302-308` (workspace switcher) and `:410-416` (user avatar/logout) use only `title=` for the tooltip — `title` does not surface as an accessible name on focus, only on hover, and is announced inconsistently across screen readers. The avatar/logout button at line 410 has no `aria-label` at all; its accessible name is the user's initial character ("R"). Same for line 302 (workspace initial). WCAG 4.1.2.

### 10. Sync status announcements churn

`web/src/components/Editor.tsx:854` uses `role="status" aria-live="polite" aria-atomic="true"` wrapping the four-state sync indicator. Because the text content flips between "Saving"/"Saved"/"Cached"/"Offline" frequently during normal typing, NVDA and JAWS will read the status repeatedly. Should be `aria-live="off"` for routine state and switch to polite only on transitions out of `synced`, or debounced.

### 11. `<label>` elements widely misused as decorative typography

There are ~25 `<label>` elements without `htmlFor` or wrapping any control — they're being used purely as styled text. Examples: `web/src/components/sidebars/PropertiesPanel.tsx:281,319,367,375`, `web/src/components/ProjectRetro.tsx:200,255,266,283,331`, `web/src/components/sidebars/WikiSidebar.tsx:94`, `web/src/components/review/WeeklyReviewSubNav.tsx:143,166,177,213`, `web/src/components/sidebars/DocumentTypeSelector.tsx:30`. Use `<div>`, `<span>`, or `<p>` for these. Decorative `<label>` causes screen readers to announce "label" inappropriately and confuses form-association heuristics.

### 12. Form fields' error messages not connected to inputs

`web/src/components/ProjectSetupWizard.tsx:110-112` and `:142-144` render error text in `<p>` adjacent to the input but do not set `aria-describedby` linking field → error. `aria-invalid` is also not set. The Login page does it correctly (`web/src/pages/Login.tsx:252-253`) — the pattern just needs to be propagated. WCAG 3.3.1 / 3.3.3.

### 13. WorkspaceSettings: `<label>` not associated with the input

`web/src/pages/WorkspaceSettings.tsx:589-597` and `:600-610` render `<label>Token Name</label>` and `<label>Expires</label>` without `htmlFor` and without wrapping the input. Result: the visually-labeled fields have no programmatic label. The audit caught the select but not this related pattern in the same file.

Also: the invite email input at `WorkspaceSettings.tsx:412-419` has only `placeholder="Email address"` — no label, no `aria-label`. Placeholder is not a name.

### 14. CommandPalette focus management on close

`web/src/components/CommandPalette.tsx:42-101` implements a focus trap but does not save the previously-focused element on open or restore it on close. After Cmd+K → Escape, focus is dropped on the document body. The Radix dialogs (SessionTimeoutModal, ConfirmDialog, ProjectSetupWizard, ActionItemsModal) get this for free; CommandPalette is hand-rolled and doesn't.

### 15. SelectableList table semantics conflict with ARIA

`web/src/components/SelectableList.tsx:117-130` puts `role="grid"` on a `<table>`. That's valid but overrides the native table semantics — `<th>` at `:134,136` no longer announce as column headers (they become generic cells). The `<th>` elements also lack `scope="col"`. If you want grid behavior, use `role="columnheader"`; if you want native table announcement, drop `role="grid"` and switch the keyboard model. Currently you get neither cleanly.

Also: `<th className="w-10 px-2 py-2" aria-label="Selection">` at `:134` is an empty header with aria-label only — screen readers may or may not announce.

### 16. ResizableImage in TipTap forces `alt=""`

`web/src/components/editor/ResizableImage.tsx:62` always renders `alt={node.attrs.alt || ''}`, and `web/src/components/editor/ImageUpload.tsx:129` always sets `alt: file.name`. There is no UI for the user to write meaningful alt text. Every uploaded image is effectively unlabeled (filename is not a description). WCAG 1.1.1. This is a content-creation tooling gap, not a coding bug, but it produces inaccessible documents.

### 17. Heatmap/grid: color-coded current week with no non-color cue

The "current week" highlight in `web/src/components/StatusOverviewHeatmap.tsx:400` and `web/src/components/AccountabilityGrid.tsx:281` is `ring-1 ring-accent/30` plus blue text. Both signals are color. WCAG 1.4.1. Add a text marker ("This week") or icon.

### 18. Existing E2E suite isn't gated

`e2e/accessibility-remediation.spec.ts` already runs ~60 axe-based tests including `wcag22aa` tags on Login, Docs, and Issues (lines 1517-1563). The audit doesn't mention this exists. No `.github/workflows/` directory exists either, so even though the tests are written, they don't run in CI. The audit's CI-gating recommendation is stronger when framed as "the tests already exist — they just need a workflow".

## Where the audit overstated or under-prioritized

- **"Lighthouse 100" on Docs / Issues / Programs / Projects** is misleading. Lighthouse cannot evaluate the TipTap editor's accessibility, can't detect role-grid pseudo-tables, and can't measure whether `aria-controls` IDs resolve. Treat these scores as "no automatic regressions" rather than "accessible".
- **"Full keyboard navigation, 168/169 on Issues"** measures Tab-reachability. It doesn't say whether each control's purpose is announced, whether the activate-with-keyboard flow works (e.g., the comment context menu doesn't), or whether arrow-key roving works in expected patterns (the tree doesn't follow the WAI-ARIA tree pattern — `web/src/components/DocumentTreeItem.tsx` has zero `onKeyDown`/`ArrowDown`/`ArrowRight` handlers despite using `role="treeitem"`).
- **"Screen-reader proxy: Pass"** — the proxy in `audit-runner.spec.ts:170-171` treats `placeholder` as a name (`hasName` falls through to it). That hides items like the title textarea, the invite-email input, and most search inputs. The proxy passing does not equal SR coverage; it equals "has any non-empty attribute the proxy looks at".
- **"Color contrast failures: 3 Serious"** undercounts. Every interactive use of `text-accent` on `bg-background` fails: combobox check-mark indicators (`web/src/components/ui/Combobox.tsx:138`), MultiPersonCombobox, ProjectCombobox, ProgramCombobox, PersonCombobox check states; `web/src/components/DashboardSidebar.tsx:36,51` active-link styling; `web/src/components/StandupFeed.tsx:317` mentions; `web/src/components/PlanQualityBanner.tsx:268,511` spinner color (probably acceptable as not-text); `web/src/components/document-tabs/ProgramWeeksTab.tsx:120`; `web/src/components/IssuesList.tsx:1062,1175` "Create an issue" link. The 3 reported failures are the tip — the underlying problem is one design token used in many places.

## Concrete additional recommendations, ordered

### Critical (WCAG A / 4.1.2 — name/role/value)

1. Add `aria-label="Document title"` to the title textarea in `web/src/components/Editor.tsx:927-949`. Remove or hide the duplicate small `<h1>` at `:843` so there's a single source of truth for the title.
2. Add `aria-label="Document body"`, `aria-multiline="true"`, `role="textbox"` to `editorProps.attributes` in `web/src/components/Editor.tsx:622-625`.
3. Wire `aria-describedby` + `aria-invalid` on `ProjectSetupWizard` field errors (`web/src/components/ProjectSetupWizard.tsx:96-112,120-144`).
4. Associate the WorkspaceSettings "Token Name" / "Expires" labels with their inputs via `htmlFor`/`id` (`web/src/pages/WorkspaceSettings.tsx:589-610`). Add a label/aria-label to the invite email input at `:412`.
5. Replace `title` with `aria-label` on the workspace switcher (`App.tsx:302`) and the logout/avatar button (`App.tsx:410-416`).

### Serious (WCAG A / 1.3.1, 2.1.1, 2.1.4)

6. Add a real `id="tabpanel-..."` + `role="tabpanel"` + `aria-labelledby="tab-..."` wrapper in `web/src/pages/UnifiedDocumentPage.tsx:500-512`. Add roving tabindex + ArrowLeft/Right handlers in `web/src/components/ui/TabBar.tsx`.
7. Make the comment context menu in `web/src/components/Editor.tsx:954-978` keyboard-invokable (Shift+F10 or context-menu key already fire `onContextMenu`, so test those), give it `role="menu"`, manage focus to the first item, and dismiss on Escape.
8. Remove `aria-grabbed` from `KanbanBoard.tsx:283` and wire `@dnd-kit/accessibility` `LiveRegion` + `screenReaderInstructions` instead.
9. Convert the `c` / `g`-prefix shortcuts in `IssuesList.tsx:1011` and `Projects.tsx:317` to require a modifier, or add a settings toggle to disable them.
10. Add `role="grid"` + `role="row"` + `role="columnheader"` + `role="rowheader"` semantics to `StatusOverviewHeatmap.tsx` and `AccountabilityGrid.tsx`, or rewrite as a `<table>`. Add a non-color "This week" badge on the current-week header.

### Serious (WCAG AA / 1.4.3, 2.3.3)

11. Introduce an `accent-text` token (#0079c2 or lighter) and search-replace `text-accent` for **text usage** (not background usage like `bg-accent`). Affected files include Combobox.tsx, MultiPersonCombobox, ProjectCombobox, ProgramCombobox, PersonCombobox, DashboardSidebar, StandupFeed, IssuesList, AccountabilityGrid, StatusOverviewHeatmap, DocumentTreeItem, WeekTimeline, ProgramProjectsTab, ProgramWeeksTab, VisibilityDropdown. Audit lists 3 spots; the design-token replacement covers ~20+.
12. Replace `isFuture && 'opacity-40'` in `MyWeekPage.tsx:339` with explicit muted text colors and a status pill ("Upcoming").
13. Add a global reduced-motion rule in `web/src/index.css`:
    ```css
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
    }
    ```
    and remove or gate `animate-pulse` on the accountability banner / sync indicator.

### Moderate / Polish

14. Refactor decorative `<label>` elements to `<div>`/`<p>`/`<span>` (~25 occurrences listed above).
15. Strip `role="grid"` from `SelectableList.tsx:119` to let `<table>` semantics work, OR add `role="columnheader"` to `<th>` and `scope="col"`. Pick one model.
16. Add `aria-label`/UI for image alt text in `ResizableImage.tsx` / `ImageUpload.tsx` — at minimum prompt the user when inserting.
17. In `Login.tsx:181`, change the outer `<div>` to `<main>` (also gives Lighthouse 100).
18. Save/restore previous active element on CommandPalette open/close (`web/src/components/CommandPalette.tsx:42`).
19. Quiet the sync-status live region in `Editor.tsx:854` — switch to `aria-live="off"` for routine ticks; announce only on disconnect.
20. Wire `e2e/accessibility-remediation.spec.ts` into a GitHub Actions workflow (no `.github/workflows/` exists today). The tests are written; they just need a runner.

## Audit-runner improvements

The runner at `audit/accessibility/audit-runner.spec.ts` should:

- Drop `placeholder` from the `hasName` heuristic at `:170-171` — placeholder is not an accessible name (WCAG 3.3.2).
- Tab-reachability isn't keyboard usability. After Tab to each focusable, attempt `Enter`/`Space` and assert the expected outcome (or at minimum that the action key didn't error). Currently the runner reports "Full 168/169" without testing activation.
- Add a dedicated check for `aria-controls` integrity — for each element with `aria-controls`, assert `document.getElementById(...)` exists. That alone would catch the TabBar issue.
- Add a check that the contenteditable editor (`.ProseMirror`) has an accessible name.
- Run a separate pass with `disableRules: ['color-contrast']` removed and explicitly enable `color-contrast-enhanced` — current axe defaults skip AAA checks that are useful spot-checks.
