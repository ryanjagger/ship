import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from '../args.js';
import { DEFAULT_BASE_URL, loadConfig } from '../config.js';
import { saveCredentials, loadCredentials, clearCredentials, credentialsPath } from '../credentials.js';
import { findResourceCommand } from '../commands/resources.js';

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
});

describe('ship CLI · config', () => {
  it('defaults baseUrl + clientId', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
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
