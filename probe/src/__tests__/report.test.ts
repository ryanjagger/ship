import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeConfig } from '../config.js';
import { createReport, pass, writeReports } from '../report.js';

function makeConfig(outputDir: string, overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    repoRoot: '/repo',
    apiUrl: 'http://localhost:3000',
    email: 'dev@ship.local',
    password: 'admin123',
    allowMutation: false,
    keepData: false,
    outputDir,
    timeoutMs: 30_000,
    runId: 'probe-fixed-test',
    onlyGroups: [],
    skipGroups: [],
    aggressiveRateLimit: false,
    ...overrides,
  };
}

describe('writeReports', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'probe-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes run-id and alias files for both json and markdown', async () => {
    const config = makeConfig(tmp);
    const report = createReport(config, [pass('test.ok', 'OK', 'runner', { ok: true })]);

    const paths = await writeReports(config, report);

    expect(paths.runJsonPath).toBe(join(tmp, 'probe-fixed-test.json'));
    expect(paths.runMarkdownPath).toBe(join(tmp, 'probe-fixed-test.md'));
    expect(paths.runHtmlPath).toBe(join(tmp, 'probe-fixed-test.html'));
    expect(paths.jsonPath).toBe(join(tmp, 'security-report.json'));
    expect(paths.markdownPath).toBe(join(tmp, 'security-report.md'));
    expect(paths.htmlPath).toBe(join(tmp, 'security-report.html'));

    const files = (await readdir(tmp)).sort();
    expect(files).toEqual([
      'probe-fixed-test.html',
      'probe-fixed-test.json',
      'probe-fixed-test.md',
      'security-report.html',
      'security-report.json',
      'security-report.md',
    ]);
  });

  it('run-id and alias files have byte-identical content per run', async () => {
    const config = makeConfig(tmp);
    const report = createReport(config, [pass('test.ok', 'OK', 'runner', { ok: true })]);

    await writeReports(config, report);

    const [runJson, aliasJson, runMd, aliasMd] = await Promise.all([
      readFile(paths(tmp).runJson, 'utf8'),
      readFile(paths(tmp).aliasJson, 'utf8'),
      readFile(paths(tmp).runMd, 'utf8'),
      readFile(paths(tmp).aliasMd, 'utf8'),
    ]);

    expect(runJson).toBe(aliasJson);
    expect(runMd).toBe(aliasMd);
  });

  it('second run preserves first run-id file but overwrites the alias', async () => {
    const first = makeConfig(tmp, { runId: 'probe-first' });
    const second = makeConfig(tmp, { runId: 'probe-second' });

    const firstReport = createReport(first, [pass('first.ok', 'First', 'runner', {})]);
    const secondReport = createReport(second, [pass('second.ok', 'Second', 'runner', {})]);

    await writeReports(first, firstReport);
    await writeReports(second, secondReport);

    const files = (await readdir(tmp)).sort();
    expect(files).toEqual([
      'probe-first.html',
      'probe-first.json',
      'probe-first.md',
      'probe-second.html',
      'probe-second.json',
      'probe-second.md',
      'security-report.html',
      'security-report.json',
      'security-report.md',
    ]);

    const aliasJson = JSON.parse(await readFile(join(tmp, 'security-report.json'), 'utf8'));
    expect(aliasJson.runId).toBe('probe-second');

    const firstRunJson = JSON.parse(await readFile(join(tmp, 'probe-first.json'), 'utf8'));
    expect(firstRunJson.runId).toBe('probe-first');
  });

  it('creates the output directory when missing', async () => {
    const nested = join(tmp, 'nested', 'output');
    const config = makeConfig(nested);
    const report = createReport(config, []);

    await writeReports(config, report);

    const files = (await readdir(nested)).sort();
    expect(files).toEqual([
      'probe-fixed-test.html',
      'probe-fixed-test.json',
      'probe-fixed-test.md',
      'security-report.html',
      'security-report.json',
      'security-report.md',
    ]);
  });
});

function paths(dir: string) {
  return {
    runJson: join(dir, 'probe-fixed-test.json'),
    runMd: join(dir, 'probe-fixed-test.md'),
    aliasJson: join(dir, 'security-report.json'),
    aliasMd: join(dir, 'security-report.md'),
  };
}
