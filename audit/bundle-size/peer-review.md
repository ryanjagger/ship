# Bundle Size Audit — Peer Review

Peer review of `audit/bundle-size/README.md`. Independent inspection of `web/` against the
current `web/dist` build (rebuilt to verify: entry chunk 2073.7 KiB / 589.5 KiB gzip — same
ballpark as the original numbers).

## What the original audit got right

- The headline finding: there is effectively **no route-level splitting**. `web/src/main.tsx`
  lines 19-44 statically import every page (24 pages). `grep -rn "React.lazy" web/src/pages
  web/src/main.tsx` returns zero hits, confirming the entry chunk has to contain the editor
  graph for any user landing on any route.
- `emoji-picker-react` (260 KiB) is statically imported in `web/src/components/EmojiPicker.tsx:2`
  even though the picker is rendered only when `isOpen` becomes true (lines 64-87). Trivial fix.
- `lowlight` pulls 37 languages via `createLowlight(common)` in
  `web/src/components/Editor.tsx:46`. Verified against
  `node_modules/.pnpm/lowlight@3.3.0/node_modules/lowlight/lib/common.js` (lines 5-41) — every
  language has a static `import` so all 37 are bundled even though no user-content code path
  asks for them; the editor accepts arbitrary `language` strings on code blocks.
- `@tanstack/query-sync-storage-persister` is genuinely unused. The persister is a custom
  IDB-keyval implementation in `web/src/lib/queryClient.ts:103-133` (`createIDBPersister`);
  the listed dependency in `web/package.json:25` is dead.
- The two ineffective dynamic imports in `web/src/components/editor/SlashCommands.tsx:377` and
  `:445` are real — `web/src/components/Editor.tsx:31-32` static-imports both
  `ImageUploadExtension` and `FileAttachmentExtension`, which transitively pull
  `services/upload.ts` into the main graph.

## What it missed

### 1. The USWDS icon recommendation is *worse* than implied — practically all 245 chunks are dead
The audit (recommendation 6) suggests trimming the icon set. The actual situation: there is
**only one production caller** of `<Icon>` and it sits behind a dev-mode-only branch.

- `web/src/components/icons/uswds/Icon.tsx:23-26` runs `import.meta.glob('/node_modules/
  @uswds/uswds/dist/img/usa-icons/*.svg', { query: '?react' })`. Vite treats every glob match
  as a discoverable lazy entry → 245 emitted chunks (~92 KiB raw, plus per-chunk HTTP overhead).
- Production usages of `<Icon name="…">`: a `grep -rn` across `web/src` (excluding tests, JSDoc
  examples, and the Icon source itself) finds them only in
  `web/src/pages/Login.tsx:362-365`, which is inside
  `{import.meta.env.VITE_APP_ENV !== 'production' && …}` (line 358).
- In production builds this block tree-shakes away (Vite inlines the env constant), so all 245
  chunks are emitted for code that never runs. They cost storage and CDN cache slots, not
  initial load, but the original audit framed this as "an explicit used-icon map would reduce
  emitted files" — the correct framing is "delete the import.meta.glob entirely and inline a
  hand-picked 5-icon module, or remove the Icon component and the `@uswds/uswds` dependency
  outright". The Icon component appears to be unused infrastructure.

Estimated saving: ~92 KiB JS plus 245 CDN entries. Also removes
`scripts/generate-icon-types.ts` and the 513-line `web/src/components/icons/uswds/types.ts`
maintenance burden.

### 2. `diff-match-patch` is statically pulled into the entry chunk via a single inline call site
- `web/src/components/DiffViewer.tsx:2` imports the whole 78 KB CJS bundle.
- `DiffViewer` is imported by `ApprovalButton` (line 4), which is imported by
  `PropertiesPanel`, `WeekSidebar`, and `ProjectSidebar` (the standard sidebar tree). Those
  sidebars flow through `UnifiedEditor` → most editor routes → the eager `main.tsx` import
  chain.
- `DiffViewer` is only rendered inside `ApprovalButton`'s dialog (line 227) — i.e., only when
  the approve dialog is open. The audit's recommendation #4 ("split editor/collaboration code
  away") would catch this transitively, but it is worth calling out as a separate, much smaller
  fix: a one-line `React.lazy(() => import('@/components/DiffViewer'))` saves 78 KB raw
  / ~19 KiB gzip with no other changes. The audit ignored diff-match-patch despite it sitting
  at 18.7 KiB in `analysis.json` line 96.

### 3. `vite.config.ts` has no `build` block at all
- `web/vite.config.ts` (full file is 95 lines) defines `plugins`, `resolve`, `server`, and
  `preview` only. No `build.target`, no `build.sourcemap`, no `build.minify`, no
  `build.rollupOptions.output.manualChunks`, no `build.cssCodeSplit` (so all CSS is forced
  into a single 65 KiB file — `dist/assets/index-DJeYp5na.css`).
- Defaults: `build.target = 'modules'` (modern browsers, fine), `minify = 'esbuild'` (fine),
  `sourcemap = false` (fine, confirmed by `ls dist/assets/*.map` returning zero results).
- The actionable miss is `manualChunks` and `cssCodeSplit`. Vite literally suggests this in
  the build warning at the end of the build log: "Use `build.rollupOptions.output.manualChunks`
  to improve chunking". Even a tiny `manualChunks` config splitting `react`, `react-dom`,
  `@tanstack/react-query` and the entire tiptap/yjs/lowlight cluster into vendor chunks would
  let the browser cache the framework across deploys (today every code change re-downloads the
  full 2 MB chunk). The original audit lists chunking only as "split editor away from non-editor
  routes" but a vendor chunking strategy is orthogonal and gives huge cache-hit wins.
- Single CSS file: Tailwind is ~16-25 KiB of the 65 KiB; the rest is unscoped global selectors
  in `web/src/index.css` (1033 lines — ProseMirror, tippy.js, table, file attachment, comment
  styles, etc.). All of those load before the user reaches a route that actually needs them.

### 4. Sidebar barrel re-export pulls every sidebar into every page that needs one
- `web/src/components/sidebars/index.ts` re-exports `WikiSidebar`, `IssueSidebar`,
  `ProjectSidebar` (which transitively imports `EmojiPicker` and `emoji-picker-react`),
  `WeekSidebar`, `ProgramSidebar`, `DocumentTypeSelector`.
- Even though `PropertiesPanel.tsx:9-13` imports the named exports directly (not via the
  barrel), this is a footgun: any consumer that imports `from '@/components/sidebars'` will
  drag the entire 5-sidebar graph in, including the emoji picker, regardless of which sidebar
  it actually needs. The barrel adds no value here and should be removed or marked
  `"sideEffects": false` at the package level.

### 5. `KanbanBoard` is statically imported but conditionally rendered
- `web/src/components/IssuesList.tsx:5` imports `KanbanBoard` eagerly; line 1232 only renders
  it `viewMode === 'kanban'`.
- KanbanBoard owns the `@dnd-kit/sortable` + `@dnd-kit/utilities` graph
  (~9.5 KiB combined in `analysis.json`). Default view mode in `useListFilters` is `list`, so
  most sessions never need it. Trivial `React.lazy` candidate.

### 6. `OrgChartPage` is in the eager bundle, owns `@dnd-kit/core`
- `web/src/main.tsx:39` imports `OrgChartPage` statically. `OrgChartPage` is 758 lines, opens
  with the full `@dnd-kit/core` imports (lines 3-15: `DndContext`, `DragOverlay`,
  `PointerSensor`, `KeyboardSensor`, etc.).
- `@dnd-kit/core` is 39 KiB in the entry chunk per `analysis.json:56-59`. This route is a
  rarely-visited internal admin tool ("team/org-chart") and pulling dnd-kit into the initial
  bundle for users who go to `/login` or `/my-week` makes no sense. The original audit's
  recommendation 1 mentions org chart in passing; this point quantifies the cost.

### 7. `tippy.js/dist/tippy.css` is dragged into the global stylesheet
- `web/src/components/Editor.tsx:43` does `import 'tippy.js/dist/tippy.css'`. Because Vite's
  default behavior with no `cssCodeSplit` aggregates all CSS into one file, this is in the
  initial CSS payload for every route, not just editor routes. Small (~3 KiB) but
  representative of why `cssCodeSplit` matters here.

### 8. PNG icon set in `public/` is 1.1 MB and largely unused
- `web/public/icons/blue/logo-1024.png` is 275 KB. Grep across `dist/index.html` and
  `dist/manifest.json` for `logo-1024` returns zero hits — it's shipped but never referenced.
  Same for several other size variants.
- The original audit reports the static-assets bucket at 1084 KiB as a single line item and
  doesn't dig in. The Ship logo is a two-color vector glyph; `web/public/icons/blue/logo.svg`
  already exists at 6.7 KiB. The PNG ladder is for legacy iOS/Android, but most of the
  large sizes (`logo-1024.png`, `logo-512.png`) are never referenced from `index.html` or the
  manifest and can be deleted.

Estimated saving: ~700 KiB of static assets (does not affect initial JS download, but matters
for first-paint when the browser preloads icons, and for CDN egress).

### 9. `tailwind-merge` is 19.6 KiB for one use site
- `web/src/lib/cn.ts:2` is the only call site. `cn()` is used everywhere but `twMerge` is only
  necessary if you're conditionally combining classes that conflict (e.g.
  `cn('p-4', condition && 'p-2')`).
- Spot check of usage: the vast majority of call sites are plain `cn('a', 'b')` or
  `cn('a', cond && 'b')` where classes don't conflict and a 200-byte `clsx` alone would
  suffice. If the codebase doesn't actually need merge semantics, replacing
  `twMerge(clsx(...))` with `clsx(...)` saves ~19 KiB.

### 10. The Vite chunk-size warning is being ignored, not just under-emphasized
- The build emits `(!) Some chunks are larger than 500 kB after minification`. The threshold is
  500 KiB; the actual chunk is 2073 KiB — over 4x the warning bound. The audit mentions the
  warning once in passing. This number alone is the headline issue and should be the framing
  for every recommendation.

## What it overstated or mis-prioritized

- **"USWDS icons … create 245 tiny chunks; an explicit used-icon map would reduce emitted
  files."** Per finding #1, the icon component is essentially dead code. "Reduce" understates
  the action — delete the glob.
- **"`highlight.js` 166.6 KiB"** is listed as a top-3 dependency without noting that it's not
  one dependency — it's 37 distinct language modules pulled by `lowlight`'s `common`. The
  recommendation says "Replace `createLowlight(common)` with an explicit smaller language set"
  but doesn't mention the alternative of lazy-registering languages on demand
  (`lowlight.register(...)` per code-block render) which would let the editor still cover any
  pasted language without baking in 37 at build time. Note this is moot if the editor itself
  is lazy-loaded (audit recommendation 4), because then the whole 166 KiB moves off the
  initial bundle.
- **Yjs collaboration stack "115.0 KiB"** is reported as a sub-item of the editor stack. It's
  not really independent — `web/src/components/Editor.tsx` is the only direct importer
  (verified: `grep -rln "from 'yjs'" web/src` returns one file). Lazy-loading the editor
  removes Yjs as a side effect; it's not a separate workstream.
- **Listing `react-dom` 129.1 KiB as a dependency to optimize** is a no-op — it's framework
  baseline. Mentioning it in the "Top 3 largest dependencies" table makes the bundle look
  less optimizable than it is (the real top-3 actionable items are emoji-picker, highlight.js
  via lowlight, and the editor graph).

## Additional recommendations, ordered by estimated savings

| # | Action | Files / lines | Approx. raw save | Approx. gzip save | Notes |
|---|--------|---------------|------------------|-------------------|-------|
| 1 | Wrap pages in `React.lazy` in `main.tsx` | `web/src/main.tsx:19-44` | ~700-900 KiB off entry chunk | ~200-260 KiB | Biggest single win. Login/Setup/InviteAccept and the four `*Editor*` routes are the obvious split points. Once these are lazy, the editor graph, Yjs, lowlight, tippy.js, diff-match-patch, and emoji-picker all leave the entry chunk together. |
| 2 | Delete the USWDS Icon component + glob, or lock to a hand-picked 5-icon module | `web/src/components/icons/uswds/Icon.tsx`, `web/src/components/icons/uswds/types.ts`, `web/src/pages/Login.tsx:355-368`, `web/package.json` (drop `@uswds/uswds`) | ~92 KiB JS + 245 chunks | n/a | The 245-chunk count is the issue, not the bytes — they're a CDN-cache-pollution and HTTP-overhead problem. |
| 3 | Lazy-import `emoji-picker-react` inside `EmojiPickerPopover` only after the popover opens | `web/src/components/EmojiPicker.tsx:2` | ~260 KiB | ~80 KiB | Already in original audit; reiterated because it's the highest-ROI single-line change. Use `const EmojiPicker = lazy(() => import('emoji-picker-react'))` inside the `isOpen` branch. |
| 4 | Add `build.rollupOptions.output.manualChunks` to `web/vite.config.ts` | `web/vite.config.ts` (no `build:` block today) | Cache wins, not size wins | ~0 | Group `react` + `react-dom` + `scheduler` into `vendor-react`, `@tiptap/*` + `prosemirror-*` + `yjs` + `y-*` + `lowlight` + `highlight.js` into `vendor-editor`, `@radix-ui/*` + `cmdk` + `tippy.js` + `@floating-ui/*` into `vendor-ui`. Without this, every code change invalidates 2 MB of cache. |
| 5 | Enable `build.cssCodeSplit: true` | `web/vite.config.ts` | ~30-40 KiB of CSS off initial paint | ~6-8 KiB | The 1033-line `web/src/index.css` mixes app, ProseMirror, tippy, comment, AI-scoring, drag-handle, and emoji-picker styles into one stylesheet. With code-split CSS, editor styles ship with editor chunks. |
| 6 | Replace `createLowlight(common)` with on-demand `lowlight.register(...)` or a 3-language minimal set (`js`, `ts`, `json`) | `web/src/components/Editor.tsx:11-12, 46, 548-552` | ~140 KiB | ~40 KiB | Only matters if editor stays in entry chunk; superseded by #1. |
| 7 | Lazy-import `DiffViewer` inside `ApprovalButton` dialog | `web/src/components/DiffViewer.tsx`, `web/src/components/ApprovalButton.tsx:4, 227` | ~78 KiB | ~20 KiB | Standalone fix even before #1 lands. |
| 8 | Lazy-import `KanbanBoard` in `IssuesList` | `web/src/components/IssuesList.tsx:5, 1232` | ~12-15 KiB | ~4 KiB | One-line lazy + Suspense fallback. |
| 9 | Drop `tailwind-merge` if no real conflict cases exist | `web/src/lib/cn.ts:2-6`, `web/package.json:57` | ~19.6 KiB | ~6 KiB | Audit codebase for `cn('p-4', cond && 'p-2')`-style conflict resolution before pulling. If none, replace with bare `clsx`. |
| 10 | Delete `@tanstack/query-sync-storage-persister` from `web/package.json` | `web/package.json:25` | minor (~2-3 KiB) | minor | Confirmed unused; already in original audit. |
| 11 | Inline or split the sidebar barrel re-export | `web/src/components/sidebars/index.ts` | depends on call-site graph | — | Convert the directory to per-module imports in callers, or delete `index.ts`. |
| 12 | Delete unreferenced large PNG variants in `public/icons/blue|white/` and convert logo to SVG where possible | `web/public/icons/blue/logo-1024.png` (275 KB), `logo-512.png` (135 KB), `logo-256.png` (66 KB), and matching white variants | ~700 KiB static assets | — | Not a JS bundle change but affects total deploy size + CDN cost; `logo-1024.png` is referenced from nothing in the built `index.html` or `manifest.json`. |
| 13 | Remove `dev-dist/` from the repo | `web/dev-dist/sw.js`, `workbox-*.js`, `registerSW.js` | n/a | n/a | Stale artifacts from an abandoned PWA experiment; nothing in `vite.config.ts` or `package.json` references workbox. Worth a `.gitignore` entry too. |

## Quick verification

Build numbers from a fresh `pnpm --filter web build` (May 19, 16:25 dist):

- `index-C2vAyoQ1.js`: 2073.7 KiB / 589.5 KiB gzip — matches the audit baseline.
- Vite emits its own chunk-size warning telling the user to use `manualChunks`. The fact that
  no one has acted on this since the warning started firing suggests the audit's
  recommendations need to be wired into a concrete `vite.config.ts` change as the entry point
  for everything else.
