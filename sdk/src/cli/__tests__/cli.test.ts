import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from '../args.js';
import { DEFAULT_BASE_URL, loadConfig } from '../config.js';
import { saveCredentials, loadCredentials, clearCredentials, credentialsPath } from '../credentials.js';
import { findResourceCommand } from '../commands/resources.js';
import { runWebhooksCommand } from '../commands/webhooks.js';

describe('ship CLI · arg parsing', () => {
  it('parses command + subcommand + value flag', () => {
    const p = parseArgs(['docs', 'create', '--title', 'hello world']);
    expect(p.command).toBe('docs');
    expect(p.sub).toBe('create');
    expect(p.flags.title).toBe('hello world');
  });

  it('treats a lone --flag as boolean true', () => {
    expect(parseArgs(['login', '--help']).flags.help).toBe(true);
  });

  it('handles no args', () => {
    expect(parseArgs([])).toEqual({ command: null, sub: null, flags: {}, rest: [] });
  });

  it('recognizes typed resource commands', () => {
    expect(findResourceCommand('issues')?.clientKey).toBe('issues');
    expect(findResourceCommand('projects')?.clientKey).toBe('projects');
    expect(findResourceCommand('wiki')?.clientKey).toBe('wikiPages');
  });

  it('parses webhooks tail flags and replay positional', () => {
    const tail = parseArgs(['webhooks', 'tail', '--interval', '5', '--subscription', 'w1']);
    expect(tail).toMatchObject({ command: 'webhooks', sub: 'tail' });
    expect(tail.flags).toMatchObject({ interval: '5', subscription: 'w1' });
    const replay = parseArgs(['webhooks', 'replay', 'del_123']);
    expect(replay).toMatchObject({ command: 'webhooks', sub: 'replay', rest: ['del_123'] });
  });
});

describe('ship CLI · webhooks command', () => {
  let env: NodeJS.ProcessEnv;
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ship-cli-wh-'));
    env = { SHIP_CONFIG_DIR: dir } as unknown as NodeJS.ProcessEnv;
    // requireClient reads process.env (no env arg), so set it for these cases.
    prevConfigDir = process.env.SHIP_CONFIG_DIR;
    process.env.SHIP_CONFIG_DIR = dir;
  });
  afterEach(async () => {
    if (prevConfigDir === undefined) delete process.env.SHIP_CONFIG_DIR;
    else process.env.SHIP_CONFIG_DIR = prevConfigDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const config = loadConfig({} as NodeJS.ProcessEnv);

  it('prints usage and exits 1 with no subcommand', async () => {
    expect(await runWebhooksCommand(config, null, {}, [])).toBe(1);
  });

  it('requires sign-in', async () => {
    // No credentials saved → requireClient fails before any network call.
    expect(await runWebhooksCommand(config, 'list', {}, [])).toBe(1);
  });

  it('validates create flags before any network call (signed in)', async () => {
    await saveCredentials({ token: 'ship_at_x', baseUrl: DEFAULT_BASE_URL, obtainedAt: '2026-01-01T00:00:00Z' }, env);
    // Missing --url/--events → returns 1 without hitting the API.
    expect(await runWebhooksCommand(config, 'create', {}, [])).toBe(1);
    // Missing delivery id for replay → returns 1 without hitting the API.
    expect(await runWebhooksCommand(config, 'replay', {}, [])).toBe(1);
  });

  it('rejects a non-numeric tail --interval before polling (signed in)', async () => {
    await saveCredentials({ token: 'ship_at_x', baseUrl: DEFAULT_BASE_URL, obtainedAt: '2026-01-01T00:00:00Z' }, env);
    // NaN interval must fail fast, not spin polling the API.
    expect(await runWebhooksCommand(config, 'tail', { interval: 'nope' }, [])).toBe(1);
    expect(await runWebhooksCommand(config, 'tail', { interval: '0' }, [])).toBe(1);
  });
});

describe('ship CLI · config', () => {
  it('defaults baseUrl + clientId', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(DEFAULT_BASE_URL).toBe('https://ship-app-production-6f9e.up.railway.app');
    expect(c.baseUrl).toBe('https://ship-app-production-6f9e.up.railway.app');
    expect(c.clientId).toBe('client_ship_cli');
  });

  it('reads env overrides and trims a trailing slash', () => {
    const c = loadConfig({ SHIP_API_URL: 'https://ship.example.com/', SHIP_CLIENT_ID: 'client_x' } as unknown as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe('https://ship.example.com');
    expect(c.clientId).toBe('client_x');
  });
});

describe('ship CLI · credentials store', () => {
  let env: NodeJS.ProcessEnv;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ship-cli-'));
    env = { SHIP_CONFIG_DIR: dir } as unknown as NodeJS.ProcessEnv;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves with 0600 perms and round-trips', async () => {
    const path = await saveCredentials(
      { token: 'ship_at_abc', baseUrl: DEFAULT_BASE_URL, obtainedAt: '2026-01-01T00:00:00Z' },
      env
    );
    expect(path).toBe(credentialsPath(env));
    const stat = await fs.stat(path);
    expect(stat.mode & 0o777).toBe(0o600);

    const loaded = await loadCredentials(env);
    expect(loaded?.token).toBe('ship_at_abc');
    expect(loaded?.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('returns null when absent, and after clear', async () => {
    expect(await loadCredentials(env)).toBeNull();
    await saveCredentials({ token: 't', baseUrl: 'b', obtainedAt: 'now' }, env);
    expect(await loadCredentials(env)).not.toBeNull();
    await clearCredentials(env);
    expect(await loadCredentials(env)).toBeNull();
  });
});
