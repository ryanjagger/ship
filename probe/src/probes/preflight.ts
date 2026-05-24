import { spawn } from 'node:child_process';
import type { ProbeConfig } from '../config.js';
import { ProbeHttpClient, type ProbeResponse } from '../http-client.js';
import { finding, pass, type ProbeCheck } from '../report.js';

type TimedResponse = {
  response: ProbeResponse;
  durationMs: number;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  json?: unknown;
};

const BODY_PREVIEW_LENGTH = 500;

export async function runPreflightProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const userAgent = `ship-probe/${config.runId}`;
  const checks: ProbeCheck[] = [];

  const apiClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  checks.push(await checkApiTarget(config, apiClient));

  if (config.webUrl) {
    const webClient = new ProbeHttpClient(config.webUrl, config.timeoutMs, userAgent);
    checks.push(await checkWebTarget(config, webClient));
  }

  checks.push(await checkCredentials(config));
  checks.push(checkMutationFlag(config));
  checks.push(await checkPnpmAudit(config));

  return checks;
}

async function checkApiTarget(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  const health = await timedRequest(client, '/health');
  const attempts = [responseEvidence('/health', health)];

  if (health.response.ok) {
    return pass('preflight.api_target.reachable', 'API target is reachable', 'preflight', {
      apiUrl: config.apiUrl,
      attempts,
    }, [`GET ${config.apiUrl}/health`]);
  }

  const csrf = await timedRequest(client, '/api/csrf-token');
  attempts.push(responseEvidence('/api/csrf-token', csrf, { redactBody: true }));

  if (csrf.response.ok) {
    return pass('preflight.api_target.reachable', 'API target is reachable through CSRF fallback', 'preflight', {
      apiUrl: config.apiUrl,
      attempts,
    }, [
      `GET ${config.apiUrl}/health`,
      `GET ${config.apiUrl}/api/csrf-token`,
    ]);
  }

  return finding('preflight.api_target.reachable', 'API target is not reachable', 'preflight', 'critical', {
    apiUrl: config.apiUrl,
    attempts,
  }, [
    `GET ${config.apiUrl}/health`,
    `GET ${config.apiUrl}/api/csrf-token`,
  ]);
}

async function checkWebTarget(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  const response = await timedRequest(client, '/');
  const evidence = {
    webUrl: config.webUrl,
    attempt: responseEvidence('/', response),
  };

  if (response.response.status >= 200 && response.response.status < 400) {
    return pass('preflight.web_target.reachable', 'Web target is reachable', 'preflight', evidence, [
      `GET ${config.webUrl}/`,
    ]);
  }

  return finding('preflight.web_target.reachable', 'Web target is not reachable', 'preflight', response.response.status === 0 ? 'critical' : 'medium', evidence, [
    `GET ${config.webUrl}/`,
  ]);
}

async function checkCredentials(config: ProbeConfig): Promise<ProbeCheck> {
  const client = new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`);
  const startedAt = Date.now();
  const response = await client.login(config.email, config.password);
  const evidence = {
    email: config.email,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    sessionCookiePresent: client.cookies.get('session_id') !== undefined,
    setCookies: response.setCookies.map((cookie) => ({
      name: cookie.name,
      valueLength: cookie.value.length,
      attributes: cookie.attributes,
    })),
    bodyPreview: response.ok ? undefined : response.bodyText.slice(0, BODY_PREVIEW_LENGTH),
  };

  if (response.ok) {
    return pass('preflight.credentials.login', 'Configured credentials can log in', 'preflight', evidence, [
      `GET ${config.apiUrl}/api/csrf-token`,
      `POST ${config.apiUrl}/api/auth/login with configured credentials`,
    ]);
  }

  return finding('preflight.credentials.login', 'Configured credentials cannot log in', 'preflight', 'high', evidence, [
    `GET ${config.apiUrl}/api/csrf-token`,
    `POST ${config.apiUrl}/api/auth/login with configured credentials`,
  ]);
}

function checkMutationFlag(config: ProbeConfig): ProbeCheck {
  const evidence = {
    allowMutation: config.allowMutation,
    affectedProbeGroups: ['auth.api_tokens', 'auth.role_boundaries', 'websocket.collaboration', 'inputs', 'rate-limit.write_endpoints'],
  };

  if (config.allowMutation) {
    return pass('preflight.allow_mutation.enabled', 'Mutating probes are enabled', 'preflight', evidence, [
      'Run the probe with --allow-mutation when targeting an environment where audit fixture creation is permitted.',
    ]);
  }

  return finding('preflight.allow_mutation.enabled', 'Mutating probes are disabled', 'preflight', 'medium', evidence, [
    'Rerun with --allow-mutation when targeting an environment where audit fixture creation is permitted.',
  ]);
}

async function checkPnpmAudit(config: ProbeConfig): Promise<ProbeCheck> {
  const result = await runPnpmAudit(config.repoRoot, config.timeoutMs);
  const evidence = {
    command: 'pnpm audit --json',
    cwd: config.repoRoot,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    parseableJson: result.json !== undefined,
    stdoutBytes: result.stdout.length,
    stderrPreview: result.stderr.slice(0, BODY_PREVIEW_LENGTH),
  };

  if (result.json !== undefined) {
    return pass('preflight.pnpm_audit.callable', 'pnpm audit can run and produce JSON', 'preflight', evidence, [
      'Run `pnpm audit --json` from the repository root.',
    ]);
  }

  return finding('preflight.pnpm_audit.callable', 'pnpm audit did not produce parseable JSON', 'preflight', 'medium', {
    ...evidence,
    stdoutPreview: result.stdout.slice(0, BODY_PREVIEW_LENGTH),
  }, [
    'Run `pnpm audit --json` from the repository root.',
  ]);
}

async function timedRequest(client: ProbeHttpClient, path: string): Promise<TimedResponse> {
  const startedAt = Date.now();
  const response = await client.request(path);
  return {
    response,
    durationMs: Date.now() - startedAt,
  };
}

function responseEvidence(path: string, timed: TimedResponse, options: { redactBody?: boolean } = {}): unknown {
  const shouldPreviewBody = options.redactBody || !timed.response.ok || timed.response.status === 0 || path === '/health';
  return {
    path,
    status: timed.response.status,
    ok: timed.response.ok,
    durationMs: timed.durationMs,
    contentType: timed.response.headers['content-type'],
    bodyPreview: shouldPreviewBody
      ? options.redactBody ? '[redacted]' : timed.response.bodyText.slice(0, BODY_PREVIEW_LENGTH)
      : undefined,
  };
}

function runPnpmAudit(repoRoot: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['audit', '--json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (exitCode) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr, timedOut, json: parseJson(stdout) });
    });
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr: stderr + error.message, timedOut });
    });
  });
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
