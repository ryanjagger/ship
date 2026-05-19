# Bundle Size Audit

## Audit Deliverable

Production build command:

```sh
pnpm run build:web
```

Bundle visualization artifact:

- [treemap.html](./treemap.html)
- [analysis.json](./analysis.json)

The treemap was generated from a second Vite build with source maps so package ownership could be attributed. Source maps are not counted in the production bundle totals below.

| Metric | Your Baseline |
| --- | --- |
| Total production bundle size | 2,262.7 KiB JS+CSS, 685.0 KiB gzip estimate. Full `web/dist` output including static public assets is 3,351.5 KiB. |
| Largest chunk | `assets/index-C2vAyoQ1.js` - 2,025.1 KiB, 575.7 KiB gzip |
| Number of chunks | 262 JS/CSS chunks: 261 JS and 1 CSS |
| Top 3 largest dependencies | `emoji-picker-react` 260.4 KiB; `highlight.js` 166.6 KiB; `react-dom` 129.1 KiB |
| Unused dependencies identified | `@tanstack/query-sync-storage-persister` |

## Build Output Summary

| Category | Raw size | Gzip estimate | Files |
| --- | ---: | ---: | ---: |
| JavaScript | 2,197.7 KiB | 672.4 KiB | 261 |
| CSS | 65.0 KiB | 12.6 KiB | 1 |
| HTML | 4.4 KiB | 1.1 KiB | 1 |
| Static public assets | 1,084.4 KiB | 1,035.7 KiB | 38 |
| Full `web/dist` output | 3,351.5 KiB | 1,721.8 KiB | 301 |

Vite also emitted a chunk-size warning for the entry chunk because `assets/index-C2vAyoQ1.js` is over 500 KiB after minification.

## Largest Chunks

| Chunk | Raw size | Gzip estimate | Notes |
| --- | ---: | ---: | --- |
| `assets/index-C2vAyoQ1.js` | 2,025.1 KiB | 575.7 KiB | Entry chunk; contains most app code and heavy editor dependencies |
| `assets/index-DJeYp5na.css` | 65.0 KiB | 12.6 KiB | Only emitted CSS chunk |
| `assets/ProgramWeeksTab-BzbUWlt4.js` | 16.4 KiB | 5.4 KiB | Lazy document-tab chunk |
| `assets/WeekReviewTab-DmxN07T1.js` | 12.3 KiB | 3.6 KiB | Lazy document-tab chunk |
| `assets/StandupFeed-BjJLDai5.js` | 9.4 KiB | 2.8 KiB | Lazy standup/editor chunk |
| `assets/ProjectRetroTab-BV2rvgoM.js` | 8.8 KiB | 2.3 KiB | Lazy document-tab chunk |

## Largest Dependency Areas

Source-map attribution is approximate because it assigns minified byte ranges to the original source owners.

| Area | Approx raw size | Why it matters |
| --- | ---: | --- |
| App source | 696.1 KiB | Most pages are pulled into the entry chunk from `web/src/main.tsx` static route imports |
| Tiptap/ProseMirror/editor stack | 629.6 KiB | Editor dependencies are in the entry path through statically imported document/editor pages |
| `emoji-picker-react` | 260.4 KiB | Imported synchronously by `web/src/components/EmojiPicker.tsx`, even though the picker only renders when opened |
| `highlight.js` | 166.6 KiB | Pulled through `lowlight` common languages for code-block highlighting |
| React runtime | 140.1 KiB | Mostly `react-dom`; expected baseline framework cost |
| Yjs collaboration stack | 115.0 KiB | Collaboration code is bundled with the editor path |
| USWDS icons | 92.4 KiB mapped, 102.2 KiB emitted chunks | `import.meta.glob` creates 245 lazy icon chunks |

## Unused Dependency Check

I cross-referenced `web/package.json` runtime dependencies against production source imports under `web/src`, excluding tests and mocks.

Unused direct dependency:

- `@tanstack/query-sync-storage-persister`

Important note: `@uswds/uswds` does not appear as a normal package import, but it is used by the Vite glob in `web/src/components/icons/uswds/Icon.tsx`.

## Code Splitting Findings

Code splitting is present, but it is concentrated in small places:

- `web/src/lib/document-tabs.tsx` lazy-loads document tab components.
- `web/src/components/icons/uswds/Icon.tsx` lazy-loads USWDS SVG icon modules.
- Vite emitted 14 lazy tab/editor chunks and 245 lazy icon chunks.

The biggest gap is route-level splitting. `web/src/main.tsx` statically imports nearly every page component, including admin, team, document, review, org chart, and editor routes. That keeps much of the app in `assets/index-C2vAyoQ1.js` even when a user initially lands on a small route such as login or setup.

Vite also reported two ineffective dynamic imports:

- `web/src/services/upload.ts` is dynamically imported by `SlashCommands.tsx` but statically imported by `FileAttachment.tsx` and `ImageUpload.tsx`.
- `web/src/components/editor/FileAttachment.tsx` is dynamically imported by `SlashCommands.tsx` but statically imported by `Editor.tsx`.

Those dynamic imports do not create a separate chunk today.

## Recommended Reductions

1. Add route-level `React.lazy` boundaries in `web/src/main.tsx` for non-initial pages, especially document editor, admin, team allocation, reviews, org chart, and settings routes.
2. Lazy-load `emoji-picker-react` inside `EmojiPickerPopover` only after the popover opens.
3. Replace `createLowlight(common)` with an explicit smaller language set if broad code highlighting is not required.
4. Split editor/collaboration code away from non-editor routes so Tiptap, ProseMirror, Yjs, and upload helpers are not part of the initial entry chunk.
5. Remove `@tanstack/query-sync-storage-persister` if no upcoming code path needs it.
6. Review the USWDS icon glob. The current approach keeps icons out of the entry bundle, but it creates 245 tiny chunks; an explicit used-icon map would reduce emitted files and request overhead.
