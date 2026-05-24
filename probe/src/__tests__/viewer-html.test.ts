import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeConfig } from '../config.js';
import { createReport, finding, notTested, pass } from '../report.js';
import { _resetAssetsCacheForTests } from '../viewer/assets.js';
import { renderHtml } from '../viewer/html.js';

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
    runId: 'probe-fixed-test',
    onlyGroups: [],
    skipGroups: [],
    aggressiveRateLimit: false,
    ...overrides,
  };
}

describe('renderHtml', () => {
  beforeEach(() => _resetAssetsCacheForTests());
  afterEach(() => _resetAssetsCacheForTests());

  it('returns a self-contained HTML document with inlined assets', async () => {
    const config = makeConfig();
    const report = createReport(config, [
      finding('auth.session.cookie_hardening', 'Session cookie not hardened', 'auth', 'high', { example: 1 }, ['repro']),
      pass('headers.ok', 'Headers present', 'headers', { ok: true }),
      notTested('inputs.skipped', 'Skipped because mutation disabled', 'inputs', { reason: 'mutation off' }),
    ]);

    const html = await renderHtml(report);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<script id="probe-data" type="application/json">');

    expect(html).not.toMatch(/<(?:script|link|img)[^>]*\s(?:src|href)="(?!data:)https?:|<(?:script|link|img)[^>]*\s(?:src|href)="\/\//);
  });

  it('inlines the report JSON intact under the probe-data script tag', async () => {
    const config = makeConfig();
    const report = createReport(config, [pass('test.ok', 'OK', 'runner', { ok: true })]);

    const html = await renderHtml(report);
    const match = html.match(/<script id="probe-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const jsonText = match?.[1] ?? '';
    const parsed = JSON.parse(jsonText);
    expect(parsed.runId).toBe('probe-fixed-test');
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0].id).toBe('test.ok');
  });

  it('escapes </script> inside the inlined JSON', async () => {
    const config = makeConfig();
    const report = createReport(config, [
      pass('xss.test', 'evidence containing </script>', 'runner', { html: '<script>alert(1)</script>' }),
    ]);

    const html = await renderHtml(report);
    const match = html.match(/<script id="probe-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const jsonText = match?.[1] ?? '';
    expect(jsonText).not.toContain('</script>');
    expect(jsonText).toContain('<\\/script>');
  });

  it('includes both theme blocks from tokens.css', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    expect(html).toMatch(/\.theme-dark\s*\{/);
    expect(html).toMatch(/\.theme-light\s*\{/);
  });

  it('wires theme persistence via localStorage in the head init script', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    const head = html.split('</head>')[0];
    expect(head).toContain('probe-viewer-theme');
    expect(head).toContain('localStorage');
  });

  it('defines probe-status color tokens not present in tokens.css', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    expect(html).toMatch(/--status-finding:/);
    expect(html).toMatch(/--status-pass:/);
    expect(html).toMatch(/--status-not-tested:/);
  });

  it('includes a :focus-visible accessibility rule', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    expect(html).toMatch(/:focus-visible\s*\{/);
  });

  it('embeds the runtime script which references probe-data and all three statuses', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    const afterData = html.split('<script id="probe-data"')[1] ?? '';
    const runtime = afterData.split('</body>')[0] ?? '';
    expect(runtime).toContain('probe-data');
    expect(runtime).toContain('finding');
    expect(runtime).toContain('not-tested');
    expect(runtime).toContain('pass');
  });

  it('renders the skeleton with HeaderB chrome, KPI band, tabs, search input, and table', async () => {
    const html = await renderHtml(createReport(makeConfig(), []));
    expect(html).toContain('id="probe-target"');
    expect(html).toContain('id="probe-run-id"');
    expect(html).toContain('id="probe-scan-age"');
    expect(html).toContain('id="probe-theme-toggle"');
    expect(html).toContain('id="probe-kpi-findings"');
    expect(html).toContain('id="probe-kpi-critical"');
    expect(html).toContain('id="probe-kpi-not-tested"');
    expect(html).toContain('id="probe-sev-bar"');
    expect(html).toContain('id="probe-search"');
    expect(html).toContain('data-tab="findings"');
    expect(html).toContain('data-tab="not-tested"');
    expect(html).toContain('data-tab="passed"');
    expect(html).toContain('data-tab="all"');
    expect(html).toContain('data-sort="sev"');
    expect(html).toContain('id="probe-table-rows"');
  });

  it('throws a path-naming error when a viewer asset is missing', async () => {
    _resetAssetsCacheForTests();
    const assetsModule = await import('../viewer/assets.js');
    const spy = vi.spyOn(assetsModule, 'loadViewerAssets').mockRejectedValueOnce(
      new Error('Viewer asset missing: probe/design/project/tokens.css (ENOENT)')
    );
    await expect(renderHtml(createReport(makeConfig(), []))).rejects.toThrow(/tokens\.css/);
    spy.mockRestore();
  });
});
