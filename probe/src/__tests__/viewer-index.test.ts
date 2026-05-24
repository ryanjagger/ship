import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeReport } from '../report.js';
import { renderIndexHtml, scanRuns, type RunSummary } from '../viewer/index-html.js';
import { _resetAssetsCacheForTests } from '../viewer/assets.js';

function makeReport(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    tool: 'probe',
    generatedAt: '2026-05-24T10:00:00.000Z',
    runId: 'probe-fixture',
    target: { apiUrl: 'http://localhost:3000' },
    config: {
      allowMutation: false,
      keepData: false,
      databaseUrlAvailable: false,
      onlyGroups: [],
      skipGroups: [],
      aggressiveRateLimit: false,
    },
    summary: {
      total: 0,
      passed: 0,
      findings: 0,
      notTested: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    checks: [],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'probe-x',
    generatedAt: '2026-05-24T10:00:00.000Z',
    target: { apiUrl: 'http://localhost:3000' },
    summary: {
      findings: 0,
      notTested: 0,
      passed: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    ...overrides,
  };
}

describe('scanRuns', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'probe-index-'));
    _resetAssetsCacheForTests();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    _resetAssetsCacheForTests();
  });

  it('returns runs newest-first by generatedAt', async () => {
    await writeFile(join(tmp, 'probe-a.json'), JSON.stringify(makeReport({ runId: 'probe-a', generatedAt: '2026-05-22T10:00:00.000Z' })));
    await writeFile(join(tmp, 'probe-b.json'), JSON.stringify(makeReport({ runId: 'probe-b', generatedAt: '2026-05-24T10:00:00.000Z' })));
    await writeFile(join(tmp, 'probe-c.json'), JSON.stringify(makeReport({ runId: 'probe-c', generatedAt: '2026-05-23T10:00:00.000Z' })));

    const runs = await scanRuns(tmp);
    expect(runs.map((r) => r.runId)).toEqual(['probe-b', 'probe-c', 'probe-a']);
  });

  it('returns empty array when the directory does not exist', async () => {
    const runs = await scanRuns(join(tmp, 'missing'));
    expect(runs).toEqual([]);
  });

  it('returns empty array when no probe-*.json files exist', async () => {
    await writeFile(join(tmp, 'something-else.json'), '{}');
    const runs = await scanRuns(tmp);
    expect(runs).toEqual([]);
  });

  it('skips malformed files and logs a warning', async () => {
    await writeFile(join(tmp, 'probe-bad.json'), 'not-json');
    await writeFile(join(tmp, 'probe-good.json'), JSON.stringify(makeReport({ runId: 'probe-good' })));

    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warns.push(msg);

    try {
      const runs = await scanRuns(tmp);
      expect(runs.map((r) => r.runId)).toEqual(['probe-good']);
      expect(warns.some((w) => w.includes('probe-bad.json'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it('skips files missing required fields', async () => {
    await writeFile(join(tmp, 'probe-empty.json'), '{}');
    await writeFile(join(tmp, 'probe-good.json'), JSON.stringify(makeReport({ runId: 'probe-good' })));

    const runs = await scanRuns(tmp);
    expect(runs.map((r) => r.runId)).toEqual(['probe-good']);
  });
});

describe('renderIndexHtml', () => {
  beforeEach(() => _resetAssetsCacheForTests());
  afterEach(() => _resetAssetsCacheForTests());

  it('renders the empty state when no runs are present', async () => {
    const html = await renderIndexHtml([]);
    expect(html).toContain('No runs yet');
    expect(html).toContain('pnpm probe');
  });

  it('lists runs newest-first with per-run links', async () => {
    const runs: RunSummary[] = [
      makeSummary({ runId: 'probe-newest', generatedAt: '2026-05-24T10:00:00.000Z' }),
      makeSummary({ runId: 'probe-middle', generatedAt: '2026-05-23T10:00:00.000Z' }),
      makeSummary({ runId: 'probe-oldest', generatedAt: '2026-05-22T10:00:00.000Z' }),
    ];

    const html = await renderIndexHtml(runs);
    expect(html).toContain('href="./probe-newest.html"');
    expect(html).toContain('href="./probe-middle.html"');
    expect(html).toContain('href="./probe-oldest.html"');

    const newestIdx = html.indexOf('probe-newest.html');
    const middleIdx = html.indexOf('probe-middle.html');
    const oldestIdx = html.indexOf('probe-oldest.html');
    expect(newestIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(oldestIdx);
  });

  it('renders severity-mix segments with widths proportional to counts', async () => {
    const runs: RunSummary[] = [
      makeSummary({
        runId: 'probe-mix',
        summary: {
          findings: 6,
          notTested: 0,
          passed: 10,
          bySeverity: { critical: 1, high: 2, medium: 3, low: 0, info: 0 },
        },
      }),
    ];

    const html = await renderIndexHtml(runs);
    expect(html).toMatch(/probe-sev-critical[^>]*style="flex:1"/);
    expect(html).toMatch(/probe-sev-high[^>]*style="flex:2"/);
    expect(html).toMatch(/probe-sev-medium[^>]*style="flex:3"/);
  });

  it('shows the empty severity bar when a run has zero findings and zero passed', async () => {
    const runs: RunSummary[] = [
      makeSummary({
        runId: 'probe-empty',
        summary: {
          findings: 0,
          notTested: 0,
          passed: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
      }),
    ];

    const html = await renderIndexHtml(runs);
    expect(html).toMatch(/probe-sev-empty/);
  });

  it('escapes HTML in target URLs and runIds defensively', async () => {
    const runs: RunSummary[] = [
      makeSummary({ runId: 'probe-<script>', target: { apiUrl: 'http://<host>' } }),
    ];

    const html = await renderIndexHtml(runs);
    expect(html).not.toContain('probe-<script>');
    expect(html).toContain('probe-&lt;script&gt;');
  });
});
