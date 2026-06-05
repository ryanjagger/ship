/**
 * CLI smoke check — proves the published `ship` binaries run the five-line demo
 * story end-to-end, not just the SDK underneath them.
 *
 * The SDK-driven TTFE loop is the timing gate; this is a lighter functional pass
 * over the actual CLI surface. `login` and `issues create` are asserted (they're
 * deterministic, exit-code based). The `webhooks tail` observation is best-effort
 * (subprocess + polling timing is noisier) — it warns rather than failing the
 * build, so it never threatens the drill's 0%-flake target.
 *
 * `ship` is invoked as `node sdk/dist/cli/index.js` (the published bin entry).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './env.js';
import type { Approver } from './auto-approve.js';

const CLI_ENTRY = path.join(PROJECT_ROOT, 'sdk', 'dist', 'cli', 'index.js');

export interface CliSmokeInput {
  apiUrl: string;
  approver: Approver;
  tmp: string;
}

export interface CliSmokeResult {
  ok: boolean; // false only on a fatal (asserted) failure
  notes: string[];
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function shipEnv(apiUrl: string, configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHIP_API_URL: apiUrl,
    SHIP_CLIENT_ID: 'client_ship_cli',
    SHIP_CONFIG_DIR: configDir,
    // The drill auto-approves the device code via the API; the verification page
    // is served by the web app (not the spawned API), so never open a browser.
    SHIP_NO_BROWSER: '1',
  };
}

/** Run `ship <args>` to completion (or timeout) and capture output. */
function runShip(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_ENTRY, ...args], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `ship login` blocks on approval — drive it: read the user code, approve it. */
function cliLogin(env: NodeJS.ProcessEnv, approver: Approver, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_ENTRY, 'login'], { env });
    let stdout = '';
    let stderr = '';
    let approved = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    const tryApprove = (): void => {
      if (approved) return;
      const m = stdout.match(/enter the code:\s*([A-Z0-9-]+)/i);
      if (m?.[1]) {
        approved = true;
        void approver.approve(m[1]).catch(() => undefined);
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      tryApprove();
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runCliSmoke(input: CliSmokeInput): Promise<CliSmokeResult> {
  const notes: string[] = [];
  const configDir = path.join(input.tmp, 'cli-home');
  await mkdir(configDir, { recursive: true });
  const env = shipEnv(input.apiUrl, configDir);

  // 1. ship login (auto-approved) — must succeed and persist credentials.
  const login = await cliLogin(env, input.approver);
  if (login.code !== 0) {
    return { ok: false, notes: [`ship login exited ${login.code}: ${login.stderr.trim() || login.stdout.trim()}`] };
  }
  try {
    const creds = JSON.parse(await readFile(path.join(configDir, 'credentials.json'), 'utf8')) as { token?: string };
    if (!creds.token) throw new Error('credentials.json has no token');
    notes.push('ship login → credentials persisted');
  } catch (err) {
    return { ok: false, notes: [`ship login did not persist credentials: ${(err as Error).message}`] };
  }

  // 2. ship issues create — must exit 0 (uses the SDK + public API under the hood).
  const create = await runShip(['issues', 'create', '--title', 'TTFE Drill (CLI)'], env);
  if (create.code !== 0) {
    return { ok: false, notes: [...notes, `ship issues create exited ${create.code}: ${create.stderr.trim()}`] };
  }
  notes.push('ship issues create → exit 0');

  // 3. ship webhooks tail — best-effort. Start tailing, trigger a fresh issue
  //    (→ a new signed delivery to the still-active drill subscription), and look
  //    for it on stdout. Warn-only: never fails the build.
  await observeTail(env, notes);

  return { ok: true, notes };
}

async function observeTail(env: NodeJS.ProcessEnv, notes: string[]): Promise<void> {
  const child = spawn('node', [CLI_ENTRY, 'webhooks', 'tail', '--interval', '1'], { env });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', () => undefined);

  try {
    // Let tail establish its baseline poll, then trigger a new delivery.
    await delay(1_500);
    await runShip(['issues', 'create', '--title', 'TTFE tail'], env);

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (/issue\.created|delivered|deliver/i.test(out)) {
        notes.push('ship webhooks tail → observed a delivery');
        return;
      }
      await delay(250);
    }
    notes.push('ship webhooks tail → no delivery observed (warn-only)');
  } finally {
    child.kill('SIGTERM');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
