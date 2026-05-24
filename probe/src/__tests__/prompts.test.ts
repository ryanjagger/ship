import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPortsFile, parseConfig, PROBE_GROUPS, shouldRunInteractive } from '../config.js';

describe('shouldRunInteractive', () => {
  it('returns true when no args and stdin is a TTY', () => {
    expect(shouldRunInteractive([], true)).toBe(true);
  });

  it('returns false when any arg starts with `-`', () => {
    expect(shouldRunInteractive(['--api-url', 'http://x'], true)).toBe(false);
    expect(shouldRunInteractive(['-h'], true)).toBe(false);
  });

  it('returns false when stdin is not a TTY even with no args', () => {
    expect(shouldRunInteractive([], false)).toBe(false);
    expect(shouldRunInteractive([], undefined)).toBe(false);
  });

  it('returns true when positional non-flag args are present and stdin is a TTY', () => {
    // Spec: only flag-style args ("starting with -") suppress interactive mode.
    // Positional args don't appear in normal probe usage but shouldn't disable prompts.
    expect(shouldRunInteractive(['something'], true)).toBe(true);
  });
});

describe('loadPortsFile', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'probe-ports-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns API + web URLs from a valid .ports file', async () => {
    await writeFile(join(tmp, '.ports'), '# generated\nAPI=3002\nWEB=5175\nSTARTED=2026-05-24T10:00:00Z\n');
    const result = loadPortsFile(tmp);
    expect(result).toEqual({ api: 'http://localhost:3002', web: 'http://localhost:5175' });
  });

  it('handles comments, blank lines, and trailing whitespace', async () => {
    await writeFile(join(tmp, '.ports'), '# header comment\n\n  API=3000  \nWEB = 5173 \n# tail\n');
    const result = loadPortsFile(tmp);
    expect(result).toEqual({ api: 'http://localhost:3000', web: 'http://localhost:5173' });
  });

  it('ignores keys other than API and WEB', async () => {
    await writeFile(join(tmp, '.ports'), 'API=3000\nWEB=5173\nWORKTREE=ship\nSTARTED=2026-05-24T10:00:00Z\n');
    const result = loadPortsFile(tmp);
    expect(Object.keys(result).sort()).toEqual(['api', 'web']);
  });

  it('returns {} when the file is missing (does not throw)', () => {
    expect(loadPortsFile(tmp)).toEqual({});
  });

  it('returns {} when the file is empty', async () => {
    await writeFile(join(tmp, '.ports'), '');
    expect(loadPortsFile(tmp)).toEqual({});
  });
});

describe('promptForConfig integration with prompts', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('builds a ProbeConfig from prompt answers, layering over the base defaults', async () => {
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn()
        .mockResolvedValueOnce('http://localhost:3010')
        .mockResolvedValueOnce('http://localhost:5180')
        .mockResolvedValueOnce('tester@ship.local'),
      password: vi.fn().mockResolvedValueOnce('supersecret'),
      checkbox: vi.fn().mockResolvedValueOnce(['preflight', 'auth']),
      confirm: vi.fn()
        .mockResolvedValueOnce(true)   // allow mutation
        .mockResolvedValueOnce(false), // aggressive rate limit
    }));

    const { promptForConfig } = await import('../prompts.js');
    const base = parseConfig([]);
    const config = await promptForConfig(base);

    expect(config.apiUrl).toBe('http://localhost:3010');
    expect(config.webUrl).toBe('http://localhost:5180');
    expect(config.email).toBe('tester@ship.local');
    expect(config.password).toBe('supersecret');
    expect(config.onlyGroups).toEqual(['preflight', 'auth']);
    expect(config.allowMutation).toBe(true);
    expect(config.aggressiveRateLimit).toBe(false);
  });

  it('treats "all groups selected" as onlyGroups=[] (no filtering, same as flag-less default)', async () => {
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn()
        .mockResolvedValueOnce('http://localhost:3000')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('dev@ship.local'),
      password: vi.fn().mockResolvedValueOnce('admin123'),
      checkbox: vi.fn().mockResolvedValueOnce([...PROBE_GROUPS]),
      confirm: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false),
    }));

    const { promptForConfig } = await import('../prompts.js');
    const config = await promptForConfig(parseConfig([]));

    expect(config.onlyGroups).toEqual([]);
    expect(config.webUrl).toBeUndefined();
  });

  it('aggressive-rate-limit prompt surfaces the lockout warning', async () => {
    const confirmMock = vi.fn().mockResolvedValue(false);
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn().mockResolvedValue('value'),
      password: vi.fn().mockResolvedValue('pwd'),
      checkbox: vi.fn().mockResolvedValue(['preflight']),
      confirm: confirmMock,
    }));

    const { promptForConfig } = await import('../prompts.js');
    await promptForConfig(parseConfig([]));

    const messages = confirmMock.mock.calls.map((call) => String(call[0].message)).join('\n');
    expect(messages).toMatch(/limiter/i);
  });

  it('every probe group has a non-empty description in the checkbox choices', async () => {
    const checkboxMock = vi.fn().mockResolvedValue([...PROBE_GROUPS]);
    vi.doMock('@inquirer/prompts', () => ({
      input: vi.fn().mockResolvedValue('value'),
      password: vi.fn().mockResolvedValue('pwd'),
      checkbox: checkboxMock,
      confirm: vi.fn().mockResolvedValue(false),
    }));

    const { promptForConfig } = await import('../prompts.js');
    await promptForConfig(parseConfig([]));

    const call = checkboxMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const choices = call.choices as Array<{ value: string; description?: string }>;
    expect(choices).toHaveLength(PROBE_GROUPS.length);
    for (const choice of choices) {
      expect(choice.description).toBeTruthy();
      expect(choice.description!.length).toBeGreaterThan(10);
    }
  });
});
