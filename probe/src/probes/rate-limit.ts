import type { ProbeConfig } from '../config.js';
import { ProbeHttpClient, type ProbeResponse } from '../http-client.js';
import { finding, notTested, pass, type ProbeCheck, type ProbeSeverity } from '../report.js';

type RateLimitCase = {
  id: string;
  title: string;
  method: 'GET' | 'POST';
  path: string;
  attempts: number;
  severity: Exclude<ProbeSeverity, 'info'>;
  authenticated?: boolean;
  csrf?: boolean;
  body?: unknown;
  loginCredentials?: {
    email: string;
    password: string;
  };
  freshClientPerAttempt?: boolean;
};

type RateLimitAttempt = {
  index: number;
  status: number;
  ok: boolean;
  durationMs: number;
  signals: string[];
  rateLimitHeaders: Record<string, string>;
  bodyPreview: string;
};

type RateLimitResult = {
  endpoint: string;
  method: string;
  attempts: RateLimitAttempt[];
  observedSignals: string[];
  statusCounts: Record<string, number>;
  elapsedMs: number;
};

const SAFE_BURST_ATTEMPTS = 6;
const LOGIN_SIGNAL_ATTEMPTS = 2;
const ATTEMPT_DELAY_MS = 125;
const BODY_PREVIEW_LENGTH = 220;

const RATE_LIMIT_HEADERS = [
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-rate-limit-limit',
  'x-rate-limit-remaining',
  'x-rate-limit-reset',
];

const RATE_LIMIT_BODY_PATTERN = /rate.?limit|too many requests|retry later|slow down/i;

export async function runRateLimitProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const userAgent = `ship-probe/${config.runId}`;
  const checks: ProbeCheck[] = [];

  const authClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  const loginResponse = await authClient.login(config.email, config.password);

  const publicClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  checks.push(await checkRateLimitCase(config, publicClient, {
    id: 'rate_limit.csrf_token',
    title: 'No rate-limit signal observed for CSRF token requests',
    method: 'GET',
    path: '/api/csrf-token',
    attempts: SAFE_BURST_ATTEMPTS,
    severity: 'low',
  }));

  if (!loginResponse.ok) {
    checks.push(notTested('rate_limit.authenticated_cases', 'Authenticated rate-limit probes require successful login', 'rate-limit', {
      loginStatus: loginResponse.status,
      email: config.email,
      body: compactBody(loginResponse),
    }));
  } else {
    checks.push(await checkRateLimitCase(config, authClient, {
      id: 'rate_limit.search.learnings',
      title: 'No rate-limit signal observed for authenticated search requests',
      method: 'GET',
      path: `/api/search/learnings?q=${encodeURIComponent('probe rate limit')}`,
      attempts: SAFE_BURST_ATTEMPTS,
      severity: 'medium',
      authenticated: true,
    }));

    checks.push(await checkRateLimitCase(config, authClient, {
      id: 'rate_limit.issues.list',
      title: 'No rate-limit signal observed for authenticated issue list requests',
      method: 'GET',
      path: '/api/issues?state=backlog',
      attempts: SAFE_BURST_ATTEMPTS,
      severity: 'medium',
      authenticated: true,
    }));
  }

  if (!config.allowMutation || !loginResponse.ok) {
    checks.push(notTested('rate_limit.write_endpoints', 'Write endpoint rate-limit probe requires --allow-mutation', 'rate-limit', {
      allowMutation: config.allowMutation,
      loginStatus: loginResponse.status,
      reason: 'The probe sends invalid authenticated write requests with CSRF tokens.',
    }));
  } else {
    checks.push(await checkRateLimitCase(config, authClient, {
      id: 'rate_limit.issues.invalid_create',
      title: 'No rate-limit signal observed for invalid authenticated issue writes',
      method: 'POST',
      path: '/api/issues',
      attempts: SAFE_BURST_ATTEMPTS,
      severity: 'medium',
      authenticated: true,
      csrf: true,
      body: {
        title: '',
        state: 'backlog',
        priority: 'medium',
        source: 'internal',
      },
    }));
  }

  const loginClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  checks.push(await checkRateLimitCase(config, loginClient, {
    id: 'rate_limit.auth_login.configured_credentials',
    title: 'No rate-limit signal observed for login attempts',
    method: 'POST',
    path: '/api/auth/login',
    attempts: LOGIN_SIGNAL_ATTEMPTS,
    severity: 'high',
    freshClientPerAttempt: true,
    loginCredentials: {
      email: config.email,
      password: config.password,
    },
  }));

  return checks;
}

async function checkRateLimitCase(
  config: ProbeConfig,
  client: ProbeHttpClient,
  testCase: RateLimitCase
): Promise<ProbeCheck> {
  const startedAt = Date.now();
  const attempts: RateLimitAttempt[] = [];

  for (let index = 0; index < testCase.attempts; index += 1) {
    const attemptClient = testCase.freshClientPerAttempt
      ? new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`)
      : client;
    const attemptStart = Date.now();
    const response = testCase.loginCredentials
      ? await attemptClient.login(testCase.loginCredentials.email, testCase.loginCredentials.password)
      : await attemptClient.request(testCase.path, {
        method: testCase.method,
        body: testCase.body,
        csrf: testCase.csrf,
      });

    attempts.push(rateLimitAttempt(index + 1, response, Date.now() - attemptStart));

    if (index < testCase.attempts - 1) {
      await delay(ATTEMPT_DELAY_MS);
    }
  }

  const result: RateLimitResult = {
    endpoint: `${testCase.method} ${testCase.path}`,
    method: testCase.method,
    attempts,
    observedSignals: [...new Set(attempts.flatMap((attempt) => attempt.signals))],
    statusCounts: statusCounts(attempts),
    elapsedMs: Date.now() - startedAt,
  };

  const reproductionSteps = [
    `${testCase.method} ${config.apiUrl}${testCase.path} ${testCase.attempts} times with ${ATTEMPT_DELAY_MS}ms between attempts`,
    ...(testCase.authenticated ? ['Use a valid login session for the requests'] : []),
    ...(testCase.csrf ? ['Include a valid CSRF token for each request'] : []),
    ...(testCase.loginCredentials ? ['Request a fresh CSRF token before each login attempt'] : []),
    'Inspect response status codes and rate-limit headers',
  ];

  if (attempts.every((attempt) => attempt.status === 0)) {
    return notTested(testCase.id, 'Network failures prevented rate-limit assessment', 'rate-limit', result, reproductionSteps);
  }

  if (attempts.every((attempt) => [404, 405, 501].includes(attempt.status))) {
    return notTested(testCase.id, 'Endpoint was unavailable for rate-limit assessment', 'rate-limit', result, reproductionSteps);
  }

  if (result.observedSignals.length > 0) {
    return pass(
      testCase.id,
      'Rate-limit signal observed during low-volume burst',
      'rate-limit',
      result,
      reproductionSteps
    );
  }

  return finding(
    testCase.id,
    testCase.title,
    'rate-limit',
    testCase.severity,
    result,
    reproductionSteps
  );
}

function rateLimitAttempt(index: number, response: ProbeResponse, durationMs: number): RateLimitAttempt {
  const headers = pickRateLimitHeaders(response.headers);
  return {
    index,
    status: response.status,
    ok: response.ok,
    durationMs,
    signals: rateLimitSignals(response, headers),
    rateLimitHeaders: headers,
    bodyPreview: shouldCaptureBodyPreview(response) ? response.bodyText.slice(0, BODY_PREVIEW_LENGTH) : '',
  };
}

function rateLimitSignals(response: ProbeResponse, headers: Record<string, string>): string[] {
  const signals = Object.keys(headers).map((header) => `header:${header}`);
  if (response.status === 429) signals.push('status:429');
  if (RATE_LIMIT_BODY_PATTERN.test(response.bodyText)) signals.push('body:rate-limit-message');
  return signals;
}

function pickRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const header of RATE_LIMIT_HEADERS) {
    const value = headers[header];
    if (value !== undefined) picked[header] = value;
  }
  return picked;
}

function statusCounts(attempts: RateLimitAttempt[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    const key = String(attempt.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldCaptureBodyPreview(response: ProbeResponse): boolean {
  return !response.ok || response.status === 429 || RATE_LIMIT_BODY_PATTERN.test(response.bodyText);
}

function compactBody(response: ProbeResponse): unknown {
  if (typeof response.body === 'string') return response.body.slice(0, 500);
  return response.body;
}
