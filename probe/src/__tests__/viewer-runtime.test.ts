// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeConfig } from '../config.js';
import { createReport, finding, notTested, pass } from '../report.js';
import { _resetAssetsCacheForTests } from '../viewer/assets.js';
import { renderHtml } from '../viewer/html.js';
import { THEME_KEY } from '../viewer/theme.js';

// vitest's jsdom env shifts import.meta.url away from file:// so assets.ts's
// URL-based asset loader can't reach probe/design at runtime. Mock the loader
// to read the same files directly using a process-cwd-relative path that's
// stable inside vitest.
vi.mock('../viewer/assets.js', async () => {
  const repoRoot = resolve(process.cwd().endsWith('/probe') ? '..' : '.');
  const tokensCss = readFileSync(resolve(repoRoot, 'probe/design/project/tokens.css'), 'utf8');
  const runtimeJs = readFileSync(resolve(repoRoot, 'probe/src/viewer/runtime.js'), 'utf8');
  return {
    loadViewerAssets: vi.fn().mockResolvedValue({ tokensCss, runtimeJs }),
    _resetAssetsCacheForTests: vi.fn(),
  };
});

// vitest v4's jsdom integration installs a `localStorage` global whose
// prototype is missing setItem/getItem/clear. Replace it with a Map-backed
// shim that satisfies the small surface the runtime uses.
beforeAll(() => {
  const store = new Map<string, string>();
  const shim = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? (store.get(key) ?? null) : null; },
    setItem(key: string, value: string) { store.set(key, String(value)); },
    removeItem(key: string) { store.delete(key); },
    key(i: number) { return [...store.keys()][i] ?? null; },
  };
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true });
});

function makeConfig(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    repoRoot: '/repo',
    apiUrl: 'http://localhost:3000',
    email: 'dev@ship.local',
    password: 'admin123',
    allowMutation: false,
    keepData: false,
    outputDir: '/tmp/unused',
    timeoutMs: 30_000,
    runId: 'probe-jsdom-test',
    onlyGroups: [],
    skipGroups: [],
    aggressiveRateLimit: false,
    ...overrides,
  };
}

/**
 * Hydrate document with the per-run viewer HTML, then execute runtime.js so
 * the live DOM reflects the runtime's first render. Returns the localStorage
 * stub passed in for assertions.
 */
async function bootViewer(report: Parameters<typeof renderHtml>[0]): Promise<void> {
  _resetAssetsCacheForTests();
  const html = await renderHtml(report);

  // Extract <head><style>, <body> contents, and the two body <script> bodies
  // out of the emitted HTML so we can drive runtime.js against the real
  // skeleton without parsing the doctype/html wrapper through jsdom's own
  // navigation.
  const headStyle = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const bodyMatch = html.match(/<body class="sr">([\s\S]*?)<\/body>/);
  const bodyInner = bodyMatch?.[1] ?? '';
  const scripts = [...bodyInner.matchAll(/<script(?:\s+id="probe-data"[^>]*)?>([\s\S]*?)<\/script>/g)];
  const probeDataMatch = bodyInner.match(/<script id="probe-data" type="application\/json">([\s\S]*?)<\/script>/);
  const probeData = probeDataMatch?.[1] ?? '';
  const runtimeScript = scripts[scripts.length - 1]?.[1] ?? '';
  const skeleton = bodyInner.replace(/<script[\s\S]*?<\/script>/g, '');

  document.documentElement.className = 'theme-dark';
  document.head.innerHTML = `<style>${headStyle}</style>`;
  document.body.className = 'sr';
  document.body.innerHTML = `${skeleton}<script id="probe-data" type="application/json">${probeData}</script>`;

  // Execute the runtime — same body that gets inlined into the live HTML.
  new Function(runtimeScript)();
}

describe('viewer runtime (jsdom)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = 'theme-dark';
  });

  afterEach(() => {
    document.documentElement.className = 'theme-dark';
    localStorage.clear();
    _resetAssetsCacheForTests();
  });

  describe('sort behavior', () => {
    it('defaults to severity ascending (critical first)', async () => {
      const config = makeConfig();
      const report = createReport(config, [
        finding('a.low', 'A', 'auth', 'low', {}, []),
        finding('a.critical', 'C', 'auth', 'critical', {}, []),
        finding('a.medium', 'B', 'auth', 'medium', {}, []),
      ]);

      await bootViewer(report);

      const ids = Array.from(document.querySelectorAll('#probe-table-rows .probe-cell-id')).map((el) => el.textContent);
      expect(ids).toEqual(['a.critical', 'a.medium', 'a.low']);
    });

    it('clicking the sev header again toggles to descending', async () => {
      const config = makeConfig();
      const report = createReport(config, [
        finding('a.low', 'A', 'auth', 'low', {}, []),
        finding('a.critical', 'C', 'auth', 'critical', {}, []),
        finding('a.medium', 'B', 'auth', 'medium', {}, []),
      ]);

      await bootViewer(report);

      const sevHeader = document.querySelector<HTMLButtonElement>('[data-sort="sev"]');
      sevHeader?.click();

      const ids = Array.from(document.querySelectorAll('#probe-table-rows .probe-cell-id')).map((el) => el.textContent);
      expect(ids).toEqual(['a.low', 'a.medium', 'a.critical']);
    });

    it('clicking a different column resets to ascending on that column', async () => {
      const config = makeConfig();
      const report = createReport(config, [
        finding('z.x', 'Z', 'auth', 'critical', {}, []),
        finding('a.x', 'A', 'auth', 'critical', {}, []),
        finding('m.x', 'M', 'auth', 'critical', {}, []),
      ]);

      await bootViewer(report);

      const sevHeader = document.querySelector<HTMLButtonElement>('[data-sort="sev"]');
      sevHeader?.click(); // toggle sev to desc

      const titleHeader = document.querySelector<HTMLButtonElement>('[data-sort="title"]');
      titleHeader?.click(); // switch to title — should reset to asc

      const titles = Array.from(document.querySelectorAll('#probe-table-rows .probe-cell-title')).map((el) => el.textContent);
      expect(titles).toEqual(['A', 'M', 'Z']);
    });

    it('renders ▲ on the active sort column header in ascending mode', async () => {
      const report = createReport(makeConfig(), [finding('a.x', 'A', 'auth', 'critical', {}, [])]);
      await bootViewer(report);

      const sevArrow = document.querySelector('[data-sort="sev"] .probe-sort-arrow');
      expect(sevArrow?.textContent).toBe('▲');

      const titleArrow = document.querySelector('[data-sort="title"] .probe-sort-arrow');
      expect(titleArrow?.textContent).toBe('');
    });
  });

  describe('status filter tabs', () => {
    it('hydrates per-tab counts from the inlined report', async () => {
      const config = makeConfig();
      const report = createReport(config, [
        finding('f1', 'F1', 'auth', 'high', {}, []),
        finding('f2', 'F2', 'auth', 'medium', {}, []),
        pass('p1', 'P1', 'auth', {}),
        notTested('n1', 'N1', 'auth', {}),
      ]);

      await bootViewer(report);

      expect(document.getElementById('probe-tab-count-findings')?.textContent).toBe('2');
      expect(document.getElementById('probe-tab-count-passed')?.textContent).toBe('1');
      expect(document.getElementById('probe-tab-count-not-tested')?.textContent).toBe('1');
      expect(document.getElementById('probe-tab-count-all')?.textContent).toBe('4');
    });

    it('defaults to the findings tab and renders only finding rows', async () => {
      const report = createReport(makeConfig(), [
        finding('f1', 'F1', 'auth', 'high', {}, []),
        pass('p1', 'P1', 'auth', {}),
      ]);

      await bootViewer(report);

      const ids = Array.from(document.querySelectorAll('#probe-table-rows .probe-cell-id')).map((el) => el.textContent);
      expect(ids).toEqual(['f1']);
    });

    it('clicking the passed tab filters rows to status=pass only', async () => {
      const report = createReport(makeConfig(), [
        finding('f1', 'F1', 'auth', 'high', {}, []),
        pass('p1', 'P1', 'auth', {}),
        pass('p2', 'P2', 'auth', {}),
      ]);

      await bootViewer(report);

      document.querySelector<HTMLButtonElement>('[data-tab="passed"]')?.click();

      const ids = Array.from(document.querySelectorAll('#probe-table-rows .probe-cell-id')).map((el) => el.textContent);
      expect(ids.sort()).toEqual(['p1', 'p2']);
    });

    it('shows the empty-state message when a filter has no matching rows', async () => {
      const report = createReport(makeConfig(), [finding('f1', 'F1', 'auth', 'high', {}, [])]);
      await bootViewer(report);

      document.querySelector<HTMLButtonElement>('[data-tab="passed"]')?.click();

      const empty = document.querySelector('.probe-empty');
      expect(empty?.textContent).toMatch(/no rows match/);
    });
  });

  describe('theme persistence', () => {
    it('writes the new theme value to localStorage on toggle click', async () => {
      const report = createReport(makeConfig(), []);
      await bootViewer(report);

      expect(document.documentElement.className).toBe('theme-dark');
      expect(localStorage.getItem(THEME_KEY)).toBeNull();

      document.getElementById('probe-theme-toggle')?.click();

      expect(localStorage.getItem(THEME_KEY)).toBe('light');
      expect(document.documentElement.className).toBe('theme-light');

      document.getElementById('probe-theme-toggle')?.click();

      expect(localStorage.getItem(THEME_KEY)).toBe('dark');
      expect(document.documentElement.className).toBe('theme-dark');
    });

    it('templates the THEME_KEY constant into the runtime at emit time', async () => {
      // Guards against drift between viewer/theme.ts and the runtime — html.ts
      // string-replaces __PROBE_THEME_KEY__ in runtime.js at inline time.
      const repoRoot = resolve(process.cwd().endsWith('/probe') ? '..' : '.');
      const runtimeSrc = readFileSync(resolve(repoRoot, 'probe/src/viewer/runtime.js'), 'utf8');
      expect(runtimeSrc).toContain('__PROBE_THEME_KEY__');

      const report = createReport(makeConfig(), []);
      await bootViewer(report);

      document.getElementById('probe-theme-toggle')?.click();
      expect(localStorage.getItem(THEME_KEY)).toBe('light');
    });
  });

  describe('refs column', () => {
    it('renders refs as reproductionSteps + evidence-key count', async () => {
      const report = createReport(makeConfig(), [
        finding('refs.test', 'has refs', 'auth', 'high', { a: 1, b: 2, c: 3 }, ['step1', 'step2']),
      ]);

      await bootViewer(report);

      const refsCell = document.querySelector('#probe-table-rows .probe-cell-refs');
      expect(refsCell?.textContent).toBe('5');
    });

    it('renders refs as 0 when reproductionSteps and evidence are both empty', async () => {
      const report = createReport(makeConfig(), [
        pass('empty.test', 'no refs', 'auth', undefined),
      ]);

      // Switch to passed tab to see the pass row.
      await bootViewer(report);
      document.querySelector<HTMLButtonElement>('[data-tab="passed"]')?.click();

      const refsCell = document.querySelector('#probe-table-rows .probe-cell-refs');
      expect(refsCell?.textContent).toBe('0');
    });
  });
});
