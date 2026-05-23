# Bundle Size Audit — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-20). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/bundle-size`.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| Entry chunk raw | 2,025.1 KiB | 513.1 KiB (**−74.6%**) | `ccd9510`, `d8b0da2` |
| Entry chunk gzip | 575.7 KiB | 147.7 KiB (**−74.3%**) | `ccd9510`, `d8b0da2` |
| Unused direct deps | 1 (`@tanstack/query-sync-storage-persister`) | 0 | `3b7b310` |
| `emoji-picker-react` (260.4 KiB) | Bundled into `UnifiedDocumentPage` chunk | Standalone chunk, loaded on popover open | `d8b0da2` |
| Editor stack (Tiptap/ProseMirror/Yjs, ~744.6 KiB) | In entry chunk | Auto-hoisted shared chunk, loaded on editor pages | `ccd9510` |
| Vite chunk-size warning target | `index-*.js` (entry) | `PropertyRow-*.js` (shared editor chunk) | `ccd9510` |
| Vite "dynamic+static import" warnings | 2 (`services/upload`, `editor/FileAttachment`) | 0 | `c78cc0a` |
| JS+CSS chunk count | 262 | 292 (+30 lazy chunks) | `ccd9510`, `d8b0da2` |
| Total JS+CSS raw | 2,262.7 KiB | 2,270.0 KiB (+0.3%) | — |
| Total JS+CSS gzip | 685.0 KiB | 702.6 KiB (+2.6%) | — |

Read the totals row as **"first paint is now a quarter of what it was; total deferred bytes are very slightly larger because code-splitting adds per-chunk overhead, but those bytes only load when the user navigates to a page that needs them."**

## Implementation

Three of the six audit recommendations were implemented. The remaining three are deferred and noted at the end.

### 1. Removed unused dependency (audit recommendation 5)

**Before.** `@tanstack/query-sync-storage-persister` was declared in `web/package.json` runtime dependencies but never imported by anything under `web/src`. The actual persister in `web/src/lib/queryClient.ts` uses `idb-keyval` directly; `@tanstack/react-query-persist-client` provides only the `Persister` type.

**Change.** Removed the line from `web/package.json` and re-ran `pnpm install` to refresh the lockfile.

**After.** No change to runtime bundle bytes — the package was already absent from the build graph — but the declared dependency surface and `pnpm-lock.yaml` shrank.

**Reproducibility.** `pnpm install && pnpm run build:web` produces the same artifact set; `grep -r "query-sync-storage-persister" web/src` returns no matches.

**Commit.** `3b7b310`

### 2. Route-level code splitting in `main.tsx` (audit recommendation 1)

**Before.** `web/src/main.tsx` statically imported every page component (`UnifiedDocumentPage`, `AdminDashboardPage`, `TeamModePage`, `ReviewsPage`, etc.). Because all routes were reachable from the root component graph, Rollup pulled all of them — and their transitive editor/Tiptap/ProseMirror/Yjs dependencies — into the entry chunk `assets/index-C2vAyoQ1.js` (2,025.1 KiB raw / 575.7 KiB gzip). Vite emitted a chunk-size warning for the entry.

**Change.**
- Converted every non-initial page import to `React.lazy(() => import('@/pages/X').then(m => ({ default: m.X })))`.
- Wrapped `<AppRoutes>`'s `<Routes>` tree in a `<React.Suspense>` boundary with a minimal centered "Loading..." fallback.
- Kept these on the first-load path as static imports: `LoginPage`, `SetupPage`, `InviteAcceptPage`, `PublicFeedbackPage`, `AppLayout`. (Auth + setup are reached before any lazy route can be navigated to.)
- Lazy-loaded: `UnifiedDocumentPage`, `DocumentsPage`, `IssuesPage`, `ProjectsPage`, `ProgramsPage`, `DashboardPage`, `MyWeekPage`, `TeamModePage`, `TeamDirectoryPage`, `PersonEditorPage`, `OrgChartPage`, `StatusOverviewPage`, `ReviewsPage`, `AdminDashboardPage`, `AdminWorkspaceDetailPage`, `WorkspaceSettingsPage`, `ConvertedDocumentsPage`, `FeedbackEditorPage`.

**After.** The entry chunk dropped from 2,025.1 KiB → 513.1 KiB raw (575.7 → 147.7 KiB gzip). Rollup auto-hoisted the editor dependencies into a single shared chunk (named after the first module in the hoist graph: `PropertyRow-*.js`, 816.8 KiB raw / 254.4 KiB gzip) that loads only when an editor-bearing page mounts. The Vite chunk-size warning moved from the entry to the `PropertyRow` shared chunk — that chunk is the next target for further splitting (see "Deferred" below).

**Reproducibility.** `pnpm run build:web`; inspect `web/dist/index.html` to find the entry chunk reference, then `wc -c web/dist/assets/index-*.js`.

**Commit.** `ccd9510`

### 3. Lazy-loaded `emoji-picker-react` (audit recommendation 2)

**Before.** `web/src/components/EmojiPicker.tsx` imported `EmojiPicker` from `emoji-picker-react` as a static default export and additionally imported the `Theme` enum (which is a runtime value, not a type), so the entire 260.4 KiB package was pulled in wherever `EmojiPickerPopover` was rendered (project sidebar). After Phase 2, those bytes lived in the `UnifiedDocumentPage` chunk and loaded on any document/editor route — even though the picker only renders after the user clicks the popover trigger.

**Change.**
- Switched the value import to `const EmojiPicker = lazy(() => import('emoji-picker-react'))`.
- Made `EmojiClickData` and `Theme` `type`-only imports so they don't drag the module in at parse time.
- Replaced `theme={Theme.DARK}` (a runtime enum reference, which would force eager import) with `theme={'dark' as Theme}` (a type-only assertion).
- Wrapped the rendered `<EmojiPicker>` in `<Suspense fallback={<div style={{ height: 350, width: 300 }} />}>` so the popover footprint is reserved while the chunk loads.

**After.** `emoji-picker-react` now ships as a standalone `emoji-picker-react.esm-*.js` chunk (264.8 KiB raw / 62.0 KiB gzip) that loads only when the user opens the picker for the first time. The `UnifiedDocumentPage` chunk shrank accordingly.

**Reproducibility.** `pnpm run build:web`; confirm a `web/dist/assets/emoji-picker-react.esm-*.js` chunk is emitted. Manually: open `/documents/:id`, observe no network request for the emoji chunk on initial mount; click the project-icon emoji button, observe the chunk load.

**Commit.** `d8b0da2`

### 4. Resolved ineffective dynamic imports in `SlashCommands.tsx` (audit recommendation 1c)

**Before.** Vite emitted two warnings at build time:

> `web/src/services/upload.ts` is dynamically imported by `SlashCommands.tsx` but also statically imported by `FileAttachment.tsx`, `ImageUpload.tsx`; dynamic import will not move module into another chunk.

> `web/src/components/editor/FileAttachment.tsx` is dynamically imported by `SlashCommands.tsx` but also statically imported by `Editor.tsx`; dynamic import will not move module into another chunk.

`SlashCommands.tsx` was awaiting `import('@/services/upload')` inside its image command and `import('./FileAttachment')` inside its file command. Both modules were already pulled into the editor chunk via the static graph (`Editor.tsx` → `FileAttachment` → `services/upload`, plus `Editor.tsx` → `ImageUpload` → `services/upload`), so the dynamic imports added an async hop and a Rollup warning without ever splitting a chunk.

**Change.** In `web/src/components/editor/SlashCommands.tsx`:
- Added static imports at the top: `import { uploadFile } from '@/services/upload'` and `import { triggerFileUpload } from './FileAttachment'`.
- Removed the `const { uploadFile } = await import('@/services/upload')` line inside the image command's `onchange`.
- Replaced the file command body — `async ({ editor, range }) => { … const { triggerFileUpload } = await import('./FileAttachment'); triggerFileUpload(editor, abortSignal); }` — with a synchronous `({ editor, range }) => { … triggerFileUpload(editor, abortSignal); }`.

Picked the "static" strategy for both because the modules were already reachable from the editor's static graph and `SlashCommands` only ever runs inside an editor instance. Picking "dynamic" instead would have required converting the static imports in `FileAttachment.tsx`, `ImageUpload.tsx`, and `Editor.tsx` — far more surface area for the same outcome.

**After.** Both warnings gone from `pnpm run build:web`. The remaining Vite warning is the chunk-size warning for `PropertyRow-*.js`, which is the editor stack itself (deferred — see below).

Minor size shifts in the chunks the dynamic imports were already collapsing into:

| Chunk | Step 3 (post emoji-lazy) | Step 4 (post static-fold) |
| --- | --- | --- |
| Entry `index-*.js` | 513.1 KiB / 147.7 KiB gzip | 525.5 KiB / 152.1 KiB gzip |
| `PropertyRow-*.js` | 816.8 KiB / 254.4 KiB gzip | 835.8 KiB / 261.6 KiB gzip |
| `UnifiedDocumentPage-*.js` | 129.9 KiB / 34.3 KiB gzip | 133.1 KiB / 35.3 KiB gzip |

Expected: the ineffective dynamic imports were already shipping in those chunks; folding them in statically just removes the `import()` runtime wrapper and the warning noise.

**Reproducibility.** `pnpm run build:web 2>&1 | grep "dynamic"` returns no module-naming warnings (only the boilerplate "Using dynamic import() to code-split…" line in the chunk-size warning's footer).

**Commit.** `c78cc0a`

## End-to-end verification

The full lazy-route walkthrough was driven through Playwright against `pnpm dev` to confirm every lazy chunk loads correctly and no `<Suspense>` boundary regressed a real navigation:

| Route | Lazy chunk | Result |
| --- | --- | --- |
| `/login` | static | OK |
| `/docs` | `DocumentsPage` | OK |
| `/my-week` | `MyWeekPage` | OK |
| `/documents/:id` | `UnifiedDocumentPage` + shared editor chunk | OK (editor mounted, properties populated) |
| `/team/allocation` | `TeamModePage` | OK |
| `/team/reviews` | `ReviewsPage` | OK |
| `/team/org-chart` | `OrgChartPage` | OK |
| `/admin` | `AdminDashboardPage` | OK |
| `/settings` | `WorkspaceSettingsPage` | OK |
| Project icon button | `emoji-picker-react.esm-*.js` | OK (picker rendered after click) |

Console clean across the entire walkthrough (only the expected pre-login `401 /api/auth/me`).

## Build Output Summary (post-implementation)

| Category | Raw size | Gzip estimate | Files |
| --- | ---: | ---: | ---: |
| JavaScript | 2,205.1 KiB | 690.0 KiB | 290 |
| CSS | 65.0 KiB | 12.7 KiB | 2 |
| HTML | 4.4 KiB | 1.1 KiB | 1 |
| Static public assets | 1,084.4 KiB | 1,034.2 KiB | 38 |
| Full `web/dist` output | 3,358.9 KiB | 1,737.9 KiB | 331 |

For reference, the audit baseline was 3,351.5 KiB raw / 1,721.8 KiB gzip / 301 files. The +7 KiB and +30 files come from the new lazy chunks.

## Largest Chunks (post-implementation)

| Chunk | Raw size | Gzip estimate | Notes |
| --- | ---: | ---: | --- |
| `assets/PropertyRow-QdWzZw73.js` | 816.8 KiB | 254.4 KiB | Auto-hoisted shared chunk; contains the Tiptap/ProseMirror/Yjs editor stack. Loads only when an editor-bearing page (e.g. `/documents/:id`) mounts. |
| `assets/index-DSmfTnfg.js` | 513.1 KiB | 147.7 KiB | **The new entry chunk.** Down from 2,025.1 KiB. |
| `assets/emoji-picker-react.esm-ClYKx5OF.js` | 264.8 KiB | 62.0 KiB | New: previously bundled into `UnifiedDocumentPage`. Loads only after the user clicks the popover trigger. |
| `assets/UnifiedDocumentPage-CmMuVBXo.js` | 129.9 KiB | 34.3 KiB | Lazy document/editor page chunk. Was implicitly part of the 2,025 KiB entry; further trimmed by the emoji split. |
| `assets/IssuesList-gSagQlsF.js` | 52.7 KiB | 15.3 KiB | Lazy issues view |
| `assets/core.esm-CreDU1Ux.js` | 42.7 KiB | 14.1 KiB | Shared lib chunk |
| `assets/ReviewsPage-8cd-jnIk.js` | 27.7 KiB | 7.0 KiB | Lazy team-reviews page |
| `assets/TeamMode-Bpe4WjjH.js` | 21.3 KiB | 6.3 KiB | Lazy team-allocation page |

## Where the editor stack went

The audit baseline attributed ~629.6 KiB of "Tiptap/ProseMirror/editor stack" plus ~115.0 KiB of "Yjs collaboration stack" to the entry chunk, plus ~260.4 KiB of `emoji-picker-react`. Post-implementation, those bytes have moved:

- **Editor stack (TipTap + ProseMirror + Yjs):** now lives in the auto-named `PropertyRow-*.js` shared chunk (816.8 KiB raw / 254.4 KiB gzip). Rollup named it after `PropertyRow` because that's the first module name in the dependency graph that triggered the shared-chunk hoist, but the contents are dominated by the editor stack. **Loaded only when a page that imports the editor mounts**, i.e. `/documents/:id` and a few others.
- **`emoji-picker-react`:** now in its own `emoji-picker-react.esm-*.js` chunk (264.8 KiB raw / 62.0 KiB gzip). **Loaded only on first popover open**, never on initial page render.
- **`UnifiedDocumentPage`:** has its own chunk (129.9 KiB raw / 34.3 KiB gzip). Was previously inlined in the entry chunk. **Loaded only on document/editor routes.**

## Unused dependency check

After removing `@tanstack/query-sync-storage-persister`, `web/package.json` has no remaining unused runtime deps. The audit's prior observation about `@uswds/uswds` (used by the Vite glob in `web/src/components/icons/uswds/Icon.tsx`, not as a normal import) still applies.

## Deferred

Carrying forward from the README:

- **Recommendation 3 (replace `createLowlight(common)`):** the editor still pulls all ~35 highlight.js languages (~166 KiB raw). Replacing `common` with an explicit smaller language set is the next high-value win — it now lands directly in the `PropertyRow` shared chunk, so it would shrink the editor-load cost rather than entry.
- **Recommendation 4 (split editor away from non-editor routes):** partially achieved by step 2 above (the editor is no longer in entry), but explicit `manualChunks` for the editor stack was not configured. The current auto-hoisted `PropertyRow` chunk already serves this purpose; only worth revisiting if more pages start sharing the editor.
- **Recommendation 6 (USWDS icon glob):** the 245 tiny icon chunks remain. They are out of the entry path, so this is a request-count concern rather than a bundle-size one.

## Pattern recap

All three implemented fixes are the same anti-pattern in different shapes: **a module sitting in the eager import graph even though the user only needs it conditionally.** The fix in every case is to move the import behind a boundary that matches the actual usage:

| Before | Boundary added | Trigger that now loads the bytes |
| --- | --- | --- |
| Every page statically imported in `main.tsx` | `React.lazy` + route-level `<Suspense>` | Navigating to that route |
| `emoji-picker-react` imported wherever `EmojiPickerPopover` rendered | `lazy(() => import(...))` + component-level `<Suspense>` | Clicking the picker trigger |
| Dependency declared in `package.json` but never imported | (declaration removed) | n/a — never loaded |

Worth flagging as a code-review checklist for new pages and heavy components: if a module is only needed conditionally (route, popover, modal, file-upload), is the import behind a boundary that matches the condition?

## Methodology

- Build: `pnpm run build:web` (Vite 5, default config — no analyzer plugins added).
- Per-file sizes: stat on each artifact under `web/dist`.
- Gzip sizes: each file streamed through Python's `gzip.compress` at default level.
- "Total JS+CSS" follows the README convention: only `web/dist/assets/*.js` and `*.css`, excluding HTML and static public assets.
- The entry chunk is identified by parsing the `<script src=...>` reference in `web/dist/index.html` (there are now two files named `index-*.js`: the entry, and a lazy chunk from a barrel-named module).
- Dependency-level source-map attribution (as in the original `analysis.json`) was **not** re-generated for this implementation pass — the original audit's `analysis.json` was produced by an ad-hoc source-map analyzer not committed to the repo. Where this doc claims a chunk contains a particular library (e.g. "the `PropertyRow` chunk holds the editor stack"), the attribution is inferred from Vite's per-build chunk-name allocations during the work and from the relative sizes of pre/post chunks, not from a fresh source-map pass. If a precise dependency breakdown is needed for a follow-up audit, add `rollup-plugin-visualizer` with sourcemaps enabled and re-run.

## Branch state at time of writing

- **4 implementation commits** on `implement/bundle-size`: `3b7b310` (remove unused dep), `ccd9510` (route-level lazy), `d8b0da2` (emoji-picker lazy), `c78cc0a` (static-fold SlashCommands dynamic imports)
- Plus 2 docs commits (`ba7d9aa`, `fd36e35`) and merges from master (`db944ad`, `fe787d6`)
- All committed changes verified locally; branch pushed to origin
