# Bundle Size Audit — Implementation

This document records the bundle-size improvements implemented against the recommendations in [README.md](./README.md), with before/after metrics measured from a clean `pnpm run build:web`.

## What was implemented

Three of the six recommendations from the audit were implemented. The remaining three are deferred and noted at the end.

### 1. Removed unused dependency (audit recommendation 5)

Removed `@tanstack/query-sync-storage-persister` from `web/package.json`. The package was declared but never imported — the actual persister in `web/src/lib/queryClient.ts` uses `idb-keyval` directly, with `@tanstack/react-query-persist-client` providing only the `Persister` type.

Effect: no change to bundle bytes (the package was already absent from runtime), but the dependency surface and lockfile shrank.

### 2. Route-level code splitting in main.tsx (audit recommendation 1)

Converted every non-initial page import in `web/src/main.tsx` to `React.lazy`, wrapping `AppRoutes` in a `React.Suspense` boundary with a minimal loading fallback. Kept as static imports the pages on the first-load path:

- `LoginPage`, `SetupPage`, `InviteAcceptPage`, `PublicFeedbackPage`, `AppLayout`

Lazy-loaded:

- `UnifiedDocumentPage` (pulls in TipTap/ProseMirror/Yjs)
- `DocumentsPage`, `IssuesPage`, `ProjectsPage`, `ProgramsPage`
- `DashboardPage`, `MyWeekPage`
- `TeamModePage`, `TeamDirectoryPage`, `PersonEditorPage`, `OrgChartPage`, `StatusOverviewPage`, `ReviewsPage`
- `AdminDashboardPage`, `AdminWorkspaceDetailPage`
- `WorkspaceSettingsPage`, `ConvertedDocumentsPage`, `FeedbackEditorPage`

Effect: the editor stack, admin pages, and team pages are no longer in the entry chunk. Rollup auto-hoisted the editor dependencies (Tiptap, ProseMirror, Yjs) into a shared chunk that loads only when a page that needs them mounts.

### 3. Lazy-loaded emoji-picker-react (audit recommendation 2)

`web/src/components/EmojiPicker.tsx` previously imported `emoji-picker-react` statically, even though the picker only renders when its popover opens. Converted the default-export import to `React.lazy(() => import('emoji-picker-react'))` wrapped in `<Suspense>`. Used type-only imports for `EmojiClickData` and `Theme`; replaced the `Theme.DARK` value reference (which would have forced a runtime import) with the string literal `'dark' as Theme`.

Effect: `emoji-picker-react` was previously bundled into the `UnifiedDocumentPage` chunk (via the project sidebar). It now ships as a standalone chunk that loads only when the user clicks the emoji button.

## Verified end-to-end

The full lazy-route walkthrough was driven through Playwright against `pnpm dev`:

| Route | Lazy chunk | Result |
| --- | --- | --- |
| `/login` | static | ✓ |
| `/docs` | `DocumentsPage` | ✓ |
| `/my-week` | `MyWeekPage` | ✓ |
| `/documents/:id` | `UnifiedDocumentPage` + shared editor chunk | ✓ editor mounted, properties populated |
| `/team/allocation` | `TeamModePage` | ✓ |
| `/team/reviews` | `ReviewsPage` | ✓ |
| `/team/org-chart` | `OrgChartPage` | ✓ |
| `/admin` | `AdminDashboardPage` | ✓ |
| `/settings` | `WorkspaceSettingsPage` | ✓ |
| Project Icon button | `emoji-picker-react.esm-*.js` | ✓ picker rendered after click |

Console clean across the entire walkthrough (only the expected pre-login `401 /api/auth/me`).

## Headline metrics

| Metric | Baseline (audit) | After implementation | Δ |
| --- | --- | --- | --- |
| Entry chunk raw | 2,025.1 KiB | 513.1 KiB | **−74.6%** |
| Entry chunk gzip | 575.7 KiB | 147.7 KiB | **−74.3%** |
| Entry chunk name | `assets/index-C2vAyoQ1.js` | `assets/index-DSmfTnfg.js` | — |
| Total JS+CSS raw | 2,262.7 KiB | 2,270.0 KiB | +0.3% |
| Total JS+CSS gzip | 685.0 KiB | 702.6 KiB | +2.6% |
| JS+CSS chunk count | 262 | 292 | +30 chunks |
| Unused direct deps | 1 (`query-sync-storage-persister`) | 0 | — |
| Vite chunk-size warning | yes (entry) | yes (`PropertyRow` shared editor chunk) | — |

Read this table as **"first paint is now a quarter of what it was; total deferred bytes are very slightly larger because code-splitting adds per-chunk overhead, but those bytes only load when the user navigates to a page that needs them."**

## Build Output Summary

| Category | Raw size | Gzip estimate | Files |
| --- | ---: | ---: | ---: |
| JavaScript | 2,205.1 KiB | 690.0 KiB | 290 |
| CSS | 65.0 KiB | 12.7 KiB | 2 |
| HTML | 4.4 KiB | 1.1 KiB | 1 |
| Static public assets | 1,084.4 KiB | 1,034.2 KiB | 38 |
| Full `web/dist` output | 3,358.9 KiB | 1,737.9 KiB | 331 |

For reference, baseline: 3,351.5 KiB raw / 1,721.8 KiB gzip / 301 files. The +7 KiB and +30 files come from the new lazy chunks.

The Vite chunk-size warning has moved from `index-*.js` to `PropertyRow-*.js` — see "Where the editor stack went" below.

## Largest Chunks (post-implementation)

| Chunk | Raw size | Gzip estimate | Notes |
| --- | ---: | ---: | --- |
| `assets/PropertyRow-QdWzZw73.js` | 816.8 KiB | 254.4 KiB | Auto-hoisted shared chunk; contains the Tiptap/ProseMirror/Yjs editor stack. Loads only when an editor-bearing page (e.g. `/documents/:id`) mounts. |
| `assets/index-DSmfTnfg.js` | 513.1 KiB | 147.7 KiB | **The new entry chunk.** Down from 2,025.1 KiB. |
| `assets/emoji-picker-react.esm-ClYKx5OF.js` | 264.8 KiB | 62.0 KiB | New: previously bundled into `UnifiedDocumentPage`. Loads only after the user clicks the emoji popover trigger. |
| `assets/UnifiedDocumentPage-CmMuVBXo.js` | 129.9 KiB | 34.3 KiB | Lazy document/editor page chunk. Was implicitly part of the 2,025 KiB entry; further trimmed by the emoji split. |
| `assets/IssuesList-gSagQlsF.js` | 52.7 KiB | 15.3 KiB | Lazy issues view |
| `assets/core.esm-CreDU1Ux.js` | 42.7 KiB | 14.1 KiB | Shared lib chunk |
| `assets/ReviewsPage-8cd-jnIk.js` | 27.7 KiB | 7.0 KiB | Lazy team-reviews page |
| `assets/TeamMode-Bpe4WjjH.js` | 21.3 KiB | 6.3 KiB | Lazy team-allocation page |

## Where the editor stack went

The README baseline attributed ~629.6 KiB of "Tiptap/ProseMirror/editor stack" plus ~115.0 KiB of "Yjs collaboration stack" to the entry chunk, plus ~260.4 KiB of `emoji-picker-react`. Post-implementation, those bytes have moved:

- **Editor stack (TipTap + ProseMirror + Yjs):** now lives in the auto-named `PropertyRow-*.js` shared chunk (816.8 KiB raw / 254.4 KiB gzip). Rollup named it after `PropertyRow` because that's the first module name in the dependency graph that triggered the shared-chunk hoist, but the contents are dominated by the editor stack. **Loaded only when a page that imports the editor mounts**, i.e. `/documents/:id` and a few others.
- **`emoji-picker-react`:** now in its own `emoji-picker-react.esm-*.js` chunk (264.8 KiB raw / 62.0 KiB gzip). **Loaded only on first popover open**, never on initial page render.
- **`UnifiedDocumentPage`:** has its own chunk (129.9 KiB raw / 34.3 KiB gzip). Was previously inlined in the entry chunk. **Loaded only on document/editor routes.**

## Unused dependency check

After removing `@tanstack/query-sync-storage-persister`, `web/package.json` has no remaining unused runtime deps. The audit's prior observation about `@uswds/uswds` (used by the Vite glob in `web/src/components/icons/uswds/Icon.tsx`, not as a normal import) still applies.

## Recommendations not yet implemented

Carrying forward from the README:

- **Recommendation 1c (ineffective dynamic imports):** Vite's warnings about `web/src/services/upload.ts` and `web/src/components/editor/FileAttachment.tsx` being both statically and dynamically imported were not addressed. Pick one strategy per module.
- **Recommendation 3 (replace `createLowlight(common)`):** the editor still pulls all ~35 highlight.js languages (~166 KiB raw). Replacing `common` with an explicit smaller language set is the next high-value win — it now lands directly in the `PropertyRow` shared chunk, so it would shrink the editor-load cost rather than entry.
- **Recommendation 4 (split editor away from non-editor routes):** partially achieved by Phase 2 (the editor is no longer in entry), but explicit `manualChunks` for the editor stack was not configured. The current auto-hoisted `PropertyRow` chunk already serves this purpose; only worth revisiting if more pages start sharing the editor.
- **Recommendation 6 (USWDS icon glob):** the 245 tiny icon chunks remain. They are out of the entry path, so this is a request-count concern rather than a bundle-size one.

## Methodology

- Build: `pnpm run build:web` (Vite 5, default config — no analyzer plugins added).
- Per-file sizes: stat on each artifact under `web/dist`.
- Gzip sizes: each file streamed through Python's `gzip.compress` at default level.
- "Total JS+CSS" follows the README convention: only `web/dist/assets/*.js` and `*.css`, excluding HTML and static public assets.
- The entry chunk is identified by parsing the `<script src=...>` reference in `web/dist/index.html` (there are now two files named `index-*.js`: the entry, and a lazy chunk from a barrel-named module).
- Dependency-level source-map attribution (as in the original `analysis.json`) was **not** re-generated for this implementation pass — the original audit's `analysis.json` was produced by an ad-hoc source-map analyzer not committed to the repo. Where this doc claims a chunk contains a particular library (e.g. "the `PropertyRow` chunk holds the editor stack"), the attribution is inferred from Vite's per-build chunk-name allocations during the work and from the relative sizes of pre/post chunks, not from a fresh source-map pass. If a precise dependency breakdown is needed for a follow-up audit, add `rollup-plugin-visualizer` with sourcemaps enabled and re-run.
