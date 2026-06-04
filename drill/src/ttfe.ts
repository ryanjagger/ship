/**
 * The Time-to-First-Event (TTFE) drill (issue #73).
 *
 * Runs the full developer loop end-to-end against a freshly-spawned Ship, timing
 * each of the six stages and gating on per-stage + total thresholds:
 *
 *   install   — pnpm pack the SDK, install the tarball into a clean temp dir,
 *               type-check a snippet (proves clean resolution, types load,
 *               no peer-dependency errors)
 *   login     — ShipClient.deviceLogin, device code auto-approved via the
 *               seeded admin session (RFC 8628, unattended)
 *   subscribe — client.webhooks.create({ events: ['issue.created'] })
 *   trigger   — client.issues.create(...)
 *   receive   — a local 127.0.0.1 listener receives the signed POST
 *   verify    — verifyWebhook passes for the real delivery; tampered body,
 *               expired timestamp, and missing v1 each fail
 *
 * Exits non-zero (via bin.ts) if any stage exceeds its threshold or any assertion
 * fails — this is the CI build gate.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShipClient, FileTokenStore, verifyWebhook } from '@ryanjagger/ship-sdk';
import { withShipServer, PROJECT_ROOT, type ShipServer } from './env.js';
import { createApprover } from './auto-approve.js';
import { runCliSmoke } from './cli-smoke.js';
import { startListener, type Listener } from './listener.js';
import { STAGES, stageLimit, totalLimit, type Stage } from './thresholds.js';

const execFileAsync = promisify(execFile);

const CLI_CLIENT_ID = 'client_ship_cli';
const CLI_SCOPE = 'documents:read documents:write webhooks:manage people:read';

interface StageResult {
  stage: Stage;
  ms: number;
  limitMs: number;
  ok: boolean;
  note: string;
}

export async function runTtfe(): Promise<{ ok: boolean }> {
  const results: StageResult[] = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ttfe-'));
  let failure: unknown;

  await withShipServer(async (server) => {
    let listener: Listener | undefined;
    try {
      // ── install ──────────────────────────────────────────────────────────
      await stage(results, 'install', async () => {
        const note = await measureInstall(tmp);
        return note;
      });

      // The listener must exist before we subscribe so a fast delivery is caught.
      listener = await startListener();
      const lst = listener;

      // The approver stands in for the human who approves the device code; its
      // own admin login is harness setup, not part of the measured device flow.
      const approver = await createApprover(server.apiUrl, server.adminCreds);

      // ── login ────────────────────────────────────────────────────────────
      const store = new FileTokenStore(path.join(tmp, 'token.json'));
      const client = await stage(results, 'login', async () => {
        const c = await ShipClient.deviceLogin({
          clientId: CLI_CLIENT_ID,
          baseUrl: server.apiUrl,
          scope: CLI_SCOPE,
          store,
          onUserCode: async (auth) => {
            await approver.approve(auth.user_code);
          },
        });
        const persisted = await store.get();
        if (!persisted?.accessToken) throw new Error('device login did not persist an access token');
        return c;
      });

      // ── subscribe ────────────────────────────────────────────────────────
      const sub = await stage(results, 'subscribe', async () => {
        const created = await client.webhooks.create({ url: lst.url, events: ['issue.created'] });
        if (!created.secret) throw new Error('subscription create did not return a signing secret');
        return created;
      });

      // ── trigger ──────────────────────────────────────────────────────────
      const issue = await stage(results, 'trigger', async () => {
        const created = await client.issues.create({ title: 'TTFE Drill' });
        if (!created.id) throw new Error('issue create returned no id');
        return created;
      });

      // ── receive ──────────────────────────────────────────────────────────
      const delivery = await stage(results, 'receive', async () =>
        lst.waitFor((d) => verifyWebhook(d.headers, d.rawBody, sub.secret), { timeoutMs: 5_000 }),
      );

      // ── verify ───────────────────────────────────────────────────────────
      await stage(results, 'verify', async () => {
        // 1. Valid signature passes.
        if (!verifyWebhook(delivery.headers, delivery.rawBody, sub.secret)) {
          throw new Error('valid signature failed verification');
        }
        // 2. Tampered body fails.
        if (verifyWebhook(delivery.headers, delivery.rawBody + ' ', sub.secret)) {
          throw new Error('tampered body passed verification (should fail)');
        }
        // 3. Timestamp older than the 5-minute tolerance fails. The delivery's
        //    `t` is ~now; verifying as if it were 400s later trips the window.
        const t = Number(parseSignature(delivery.headers).t);
        if (verifyWebhook(delivery.headers, delivery.rawBody, sub.secret, { now: t + 400 })) {
          throw new Error('expired timestamp passed verification (should fail)');
        }
        // 4. Missing v1 component fails.
        const noV1 = { ...delivery.headers, 'ship-signature': `t=${t}` };
        if (verifyWebhook(noV1, delivery.rawBody, sub.secret)) {
          throw new Error('signature missing v1 passed verification (should fail)');
        }
        // Sanity: the event is what we triggered.
        const event = JSON.parse(delivery.rawBody) as { type?: string; data?: { object?: { id?: string } } };
        if (event.type !== 'issue.created') throw new Error(`expected issue.created, got ${String(event.type)}`);
        return `event=${event.type} issue=${issue.id}`;
      });

      // ── CLI smoke (un-timed; proves the `ship` binaries, not the gate) ─────
      // Runs while the listener + drill subscription are still live, so the
      // tail observation can catch a freshly-triggered delivery.
      console.log('\n  CLI smoke check\n');
      const cli = await runCliSmoke({ apiUrl: server.apiUrl, approver, tmp });
      for (const note of cli.notes) console.log(`  ${cli.ok ? '·' : '✗'} ${note}`);
      if (!cli.ok) throw new Error('CLI smoke check failed');
    } catch (err) {
      failure = err;
    } finally {
      await listener?.close();
    }
  }).catch((err) => {
    // Harness-level failure (DB/API spawn) — surface it as the drill failing.
    failure = failure ?? err;
  });

  const passed = report(results, failure);
  await writeResults(results, passed);
  return { ok: passed };
}

/** Time a stage, record the result, and re-throw on failure so the loop stops. */
async function stage<T>(results: StageResult[], name: Stage, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    const ms = performance.now() - t0;
    results.push({ stage: name, ms, limitMs: stageLimit(name), ok: true, note: typeof out === 'string' ? out : '' });
    return out;
  } catch (err) {
    const ms = performance.now() - t0;
    results.push({
      stage: name,
      ms,
      limitMs: stageLimit(name),
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Install stage: pack the built SDK, install the tarball into a clean temp dir,
 * and type-check a snippet that imports the public surface. Returns a one-line note.
 */
async function measureInstall(tmp: string): Promise<string> {
  const sdkDir = path.join(PROJECT_ROOT, 'sdk');
  if (!existsSync(path.join(sdkDir, 'dist', 'index.js'))) {
    throw new Error('SDK is not built (sdk/dist missing). Run: pnpm --filter @ryanjagger/ship-sdk build');
  }

  const packDir = path.join(tmp, 'pack');
  const consumer = path.join(tmp, 'consumer');
  await mkdir(packDir, { recursive: true });
  await mkdir(consumer, { recursive: true });

  // pnpm pack prints the tarball path on stdout.
  const { stdout } = await execFileAsync('pnpm', ['pack', '--pack-destination', packDir], {
    cwd: sdkDir,
    maxBuffer: 1024 * 1024 * 16,
  });
  const tarball = stdout.trim().split('\n').filter(Boolean).pop();
  if (!tarball || !existsSync(tarball)) throw new Error(`pnpm pack produced no tarball (stdout: ${stdout})`);

  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'ttfe-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2),
  );
  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['index.ts'],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumer, 'index.ts'),
    [
      "import { ShipClient, verifyWebhook } from '@ryanjagger/ship-sdk';",
      "const client = new ShipClient({ token: 'x' });",
      'export const ok = typeof client.issues.create === "function" && typeof verifyWebhook === "function";',
      '',
    ].join('\n'),
  );

  // Install the tarball — the SDK has no runtime dependencies, so this needs no
  // network and proves a clean resolution with no peer-dependency errors.
  await execFileAsync('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    maxBuffer: 1024 * 1024 * 32,
  });

  // Type-check the snippet against the installed package (proves types load).
  const tsc = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  await execFileAsync('node', [tsc, '--noEmit', '-p', 'tsconfig.json'], {
    cwd: consumer,
    maxBuffer: 1024 * 1024 * 16,
  });

  return `installed ${path.basename(tarball)}, types OK`;
}

function parseSignature(headers: Record<string, string>): { t: string; v1: string } {
  const raw = headers['ship-signature'] ?? headers['Ship-Signature'] ?? '';
  const parts = Object.fromEntries(raw.split(',').map((p) => p.split('=', 2) as [string, string]));
  return { t: parts.t ?? '', v1: parts.v1 ?? '' };
}

/** Print a timing table; return true iff every stage passed and was within budget. */
function report(results: StageResult[], failure: unknown): boolean {
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  const totalMax = totalLimit();

  console.log('\n  Time-to-First-Event drill\n');
  console.log('  stage      elapsed     limit   status');
  console.log('  ─────────  ─────────  ────────  ──────');

  let allOk = true;
  for (const name of STAGES) {
    const r = results.find((x) => x.stage === name);
    if (!r) {
      allOk = false;
      console.log(`  ${name.padEnd(9)}  ${'—'.padStart(8)}  ${fmt(stageLimit(name))}  ⨯ not run`);
      continue;
    }
    const withinBudget = r.ms <= r.limitMs;
    const ok = r.ok && withinBudget;
    allOk = allOk && ok;
    const status = !r.ok ? '⨯ FAIL' : !withinBudget ? '⨯ SLOW' : '✓';
    console.log(`  ${name.padEnd(9)}  ${fmt(r.ms)}  ${fmt(r.limitMs)}  ${status}${r.note ? `  ${r.note}` : ''}`);
  }

  const totalOk = total <= totalMax;
  allOk = allOk && totalOk;
  console.log('  ─────────  ─────────  ────────  ──────');
  console.log(`  ${'total'.padEnd(9)}  ${fmt(total)}  ${fmt(totalMax)}  ${totalOk ? '✓' : '⨯ SLOW'}`);

  if (failure) {
    console.log(`\n  ✗ Drill failed: ${failure instanceof Error ? failure.message : String(failure)}`);
  } else if (allOk) {
    console.log('\n  ✓ Drill passed — verified signed webhook end-to-end within budget.');
  } else {
    console.log('\n  ✗ Drill failed — a stage exceeded its threshold (regression).');
  }

  return allOk && !failure;
}

function fmt(ms: number): string {
  return `${Math.round(ms)}ms`.padStart(8);
}

async function writeResults(results: StageResult[], passed: boolean): Promise<void> {
  const dir = path.join(PROJECT_ROOT, 'drill', 'results');
  await mkdir(dir, { recursive: true });
  const payload = {
    drill: 'ttfe',
    passed,
    totalMs: Math.round(results.reduce((s, r) => s + r.ms, 0)),
    totalLimitMs: totalLimit(),
    stages: results.map((r) => ({
      stage: r.stage,
      ms: Math.round(r.ms),
      limitMs: r.limitMs,
      ok: r.ok,
      withinBudget: r.ms <= r.limitMs,
      note: r.note,
    })),
  };
  await writeFile(path.join(dir, 'ttfe.json'), JSON.stringify(payload, null, 2) + '\n');
}
