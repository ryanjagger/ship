import type { ProbeConfig } from '../config.js';
import { ProbeHttpClient, type ProbeResponse } from '../http-client.js';
import { finding, notTested, pass, type ProbeCheck } from '../report.js';

type HeaderCase = {
  target: 'api' | 'web';
  path: string;
  url: string;
  status: number;
  headers: Record<string, string>;
};

type SecretProbeResult = {
  target: 'api' | 'web';
  path: string;
  status: number;
  contentType?: string;
  bodyPreview: string;
  exposedIndicators: string[];
};

type CorsProbeResult = {
  name: string;
  status: number;
  allowOrigin?: string;
  allowCredentials?: string;
  allowMethods?: string;
  vary?: string;
};

const HOSTILE_ORIGIN = 'https://evil.example.invalid';
const EXPECTED_API_SECURITY_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
];

const EXPECTED_WEB_SECURITY_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
];

const VERBOSE_ERROR_PATTERNS = [
  /node_modules/i,
  /\/Users\/|\/home\/|\/var\/task\/|\/app\//i,
  /\bat\s+\S+\s+\(/,
  /SQLSTATE|PostgreSQL|Postgres|pg-pool|invalid input value for enum/i,
  /syntax error at or near/i,
  /SESSION_SECRET|DATABASE_URL|AWS_SECRET_ACCESS_KEY|PRIVATE KEY/i,
];

const SECRET_PATTERNS = [
  { label: 'database-url', pattern: /postgres(?:ql)?:\/\/[^"'\s<]+/i },
  { label: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { label: 'aws-secret-label', pattern: /AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_ACCESS_KEY_ID/i },
  { label: 'session-secret-label', pattern: /SESSION_SECRET/i },
  { label: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'jwt-like-token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'env-assignment', pattern: /\b[A-Z0-9_]{8,}=(?!\s*$)[^\s"'<>]+/ },
];

const SECRET_PATHS = [
  '/.env',
  '/.env.local',
  '/api/.env',
  '/api/.env.local',
  '/config.json',
  '/secrets.json',
  '/.aws/credentials',
  '/server.js.map',
  '/src/main.tsx',
  '/assets/index.js.map',
];

export async function runHeadersProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const userAgent = `ship-probe/${config.runId}`;
  const apiClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  const webClient = config.webUrl ? new ProbeHttpClient(config.webUrl, config.timeoutMs, userAgent) : undefined;

  checks.push(await checkCors(config, apiClient));
  checks.push(await checkSecurityHeaders(config, apiClient, webClient));
  checks.push(await checkVerboseErrors(config, apiClient));
  checks.push(await checkSecretExposure(config, apiClient, webClient));

  return checks;
}

async function checkCors(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  const getResponse = await client.request('/api/csrf-token', {
    headers: {
      origin: HOSTILE_ORIGIN,
    },
  });
  const optionsResponse = await client.request('/api/auth/login', {
    method: 'OPTIONS',
    headers: {
      origin: HOSTILE_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token',
    },
  });

  const cases = [
    corsCase('GET /api/csrf-token', getResponse),
    corsCase('OPTIONS /api/auth/login', optionsResponse),
  ];

  const failures = cases.filter((result) => {
    return result.allowOrigin === '*' ||
      result.allowOrigin === HOSTILE_ORIGIN;
  });

  if (failures.length > 0) {
    return finding('headers.cors.hostile_origin', 'CORS allows or reflects an untrusted origin', 'headers', 'high', {
      hostileOrigin: HOSTILE_ORIGIN,
      failures,
      cases,
    }, [
      `GET ${config.apiUrl}/api/csrf-token with Origin: ${HOSTILE_ORIGIN}`,
      `OPTIONS ${config.apiUrl}/api/auth/login with Origin: ${HOSTILE_ORIGIN}`,
    ]);
  }

  return pass('headers.cors.hostile_origin', 'CORS does not allow a hostile origin', 'headers', {
    hostileOrigin: HOSTILE_ORIGIN,
    cases,
  }, [
    `GET ${config.apiUrl}/api/csrf-token with Origin: ${HOSTILE_ORIGIN}`,
    `OPTIONS ${config.apiUrl}/api/auth/login with Origin: ${HOSTILE_ORIGIN}`,
  ]);
}

async function checkSecurityHeaders(
  config: ProbeConfig,
  apiClient: ProbeHttpClient,
  webClient: ProbeHttpClient | undefined
): Promise<ProbeCheck> {
  const cases: HeaderCase[] = [];
  const apiResponse = await apiClient.request('/health');
  cases.push(headerCase('api', '/health', apiResponse));

  if (webClient && config.webUrl) {
    const webResponse = await webClient.request('/');
    cases.push(headerCase('web', '/', webResponse));
  }

  const missing = cases.flatMap((result) => {
    const expected = result.target === 'api' ? EXPECTED_API_SECURITY_HEADERS : EXPECTED_WEB_SECURITY_HEADERS;
    return expected
      .filter((header) => !hasHeader(result.headers, header))
      .map((header) => ({
        target: result.target,
        path: result.path,
        header,
        status: result.status,
      }));
  });

  const weakCsp = cases
    .map((result) => ({
      target: result.target,
      path: result.path,
      csp: getHeader(result.headers, 'content-security-policy'),
    }))
    .filter((result) => result.csp && !/object-src\s+'none'/.test(result.csp));

  const unsafeInlineScript = cases
    .map((result) => ({
      target: result.target,
      path: result.path,
      csp: getHeader(result.headers, 'content-security-policy'),
    }))
    .filter((result) => result.csp?.includes("'unsafe-inline'"));

  if (missing.length > 0 || weakCsp.length > 0 || unsafeInlineScript.length > 0) {
    return finding('headers.security_headers.baseline', 'Security headers are missing or permissive', 'headers', 'medium', {
      missing,
      weakCsp,
      unsafeInlineScript,
      cases: cases.map((result) => ({
        target: result.target,
        path: result.path,
        status: result.status,
        headers: pickSecurityHeaders(result.headers),
      })),
    }, [
      `GET ${config.apiUrl}/health`,
      ...(config.webUrl ? [`GET ${config.webUrl}/`] : []),
    ]);
  }

  return pass('headers.security_headers.baseline', 'Baseline security headers are present', 'headers', {
    cases: cases.map((result) => ({
      target: result.target,
      path: result.path,
      status: result.status,
      headers: pickSecurityHeaders(result.headers),
    })),
  }, [
    `GET ${config.apiUrl}/health`,
    ...(config.webUrl ? [`GET ${config.webUrl}/`] : []),
  ]);
}

async function checkVerboseErrors(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  const loginResponse = await client.login(config.email, config.password);
  if (!loginResponse.ok) {
    return notTested('headers.verbose_errors', 'Verbose error checks require successful login for protected malformed routes', 'headers', {
      loginStatus: loginResponse.status,
      email: config.email,
      body: compactBody(loginResponse),
    });
  }

  const cases = [
    await client.request('/api/documents/not-a-uuid'),
    await client.request('/api/documents?type=not-a-real-type'),
    await client.request('/api/issues?state=not-a-real-state'),
    await client.request('/api/search/learnings?program_id=not-a-uuid'),
  ].map((response) => ({
    url: response.url,
    status: response.status,
    bodyPreview: response.bodyText.slice(0, 800),
    leakedPatterns: leakedPatterns(response.bodyText),
  }));

  const leaks = cases.filter((result) => result.leakedPatterns.length > 0);
  const serverErrors = cases.filter((result) => result.status >= 500 || result.status === 0);

  if (leaks.length > 0 || serverErrors.length > 0) {
    return finding('headers.verbose_errors', 'Malformed requests produce verbose errors or 5xx responses', 'headers', leaks.length > 0 ? 'high' : 'medium', {
      leaks,
      serverErrors,
      cases,
    }, [
      `GET ${config.apiUrl}/api/documents/not-a-uuid with a valid session`,
      `GET ${config.apiUrl}/api/documents?type=not-a-real-type with a valid session`,
      `GET ${config.apiUrl}/api/issues?state=not-a-real-state with a valid session`,
      `GET ${config.apiUrl}/api/search/learnings?program_id=not-a-uuid with a valid session`,
    ]);
  }

  return pass('headers.verbose_errors', 'Malformed requests do not expose verbose error details', 'headers', {
    cases,
  }, [
    `GET ${config.apiUrl}/api/documents/not-a-uuid with a valid session`,
    `GET ${config.apiUrl}/api/documents?type=not-a-real-type with a valid session`,
    `GET ${config.apiUrl}/api/issues?state=not-a-real-state with a valid session`,
    `GET ${config.apiUrl}/api/search/learnings?program_id=not-a-uuid with a valid session`,
  ]);
}

async function checkSecretExposure(
  config: ProbeConfig,
  apiClient: ProbeHttpClient,
  webClient: ProbeHttpClient | undefined
): Promise<ProbeCheck> {
  const results: SecretProbeResult[] = [];

  for (const path of SECRET_PATHS) {
    results.push(secretResult('api', path, await apiClient.request(path)));
    if (webClient) {
      results.push(secretResult('web', path, await webClient.request(path)));
    }
  }

  const exposures = results.filter((result) => result.status >= 200 && result.status < 300 && result.exposedIndicators.length > 0);
  const suspiciousSuccesses = results.filter((result) => {
    if (result.status < 200 || result.status >= 300) return false;
    if (result.exposedIndicators.length > 0) return false;
    const contentType = result.contentType ?? '';
    return !contentType.includes('text/html') && result.bodyPreview.length > 0;
  });

  if (exposures.length > 0) {
    return finding('secrets.live_http', 'Potential secrets are exposed over live HTTP paths', 'secrets', 'critical', {
      exposures,
      suspiciousSuccesses,
      tested: results,
    }, [
      ...SECRET_PATHS.map((path) => `GET ${config.apiUrl}${path}`),
      ...(config.webUrl ? SECRET_PATHS.map((path) => `GET ${config.webUrl}${path}`) : []),
    ]);
  }

  return pass('secrets.live_http', 'Common secret paths did not expose secret-looking values', 'secrets', {
    suspiciousSuccesses,
    tested: results,
  }, [
    ...SECRET_PATHS.map((path) => `GET ${config.apiUrl}${path}`),
    ...(config.webUrl ? SECRET_PATHS.map((path) => `GET ${config.webUrl}${path}`) : []),
  ]);
}

function corsCase(name: string, response: ProbeResponse): CorsProbeResult {
  return {
    name,
    status: response.status,
    allowOrigin: getHeader(response.headers, 'access-control-allow-origin'),
    allowCredentials: getHeader(response.headers, 'access-control-allow-credentials'),
    allowMethods: getHeader(response.headers, 'access-control-allow-methods'),
    vary: getHeader(response.headers, 'vary'),
  };
}

function headerCase(target: 'api' | 'web', path: string, response: ProbeResponse): HeaderCase {
  return {
    target,
    path,
    url: response.url,
    status: response.status,
    headers: response.headers,
  };
}

function secretResult(target: 'api' | 'web', path: string, response: ProbeResponse): SecretProbeResult {
  const bodyPreview = response.bodyText.slice(0, 800);
  return {
    target,
    path,
    status: response.status,
    contentType: getHeader(response.headers, 'content-type'),
    bodyPreview,
    exposedIndicators: secretIndicators(response.bodyText),
  };
}

function leakedPatterns(text: string): string[] {
  return VERBOSE_ERROR_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

function secretIndicators(text: string): string[] {
  return SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}

function pickSecurityHeaders(headers: Record<string, string>): Record<string, string | undefined> {
  return {
    'content-security-policy': getHeader(headers, 'content-security-policy'),
    'x-content-type-options': getHeader(headers, 'x-content-type-options'),
    'x-frame-options': getHeader(headers, 'x-frame-options'),
    'referrer-policy': getHeader(headers, 'referrer-policy'),
    'strict-transport-security': getHeader(headers, 'strict-transport-security'),
    'cross-origin-opener-policy': getHeader(headers, 'cross-origin-opener-policy'),
    'cross-origin-resource-policy': getHeader(headers, 'cross-origin-resource-policy'),
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

function compactBody(response: ProbeResponse): unknown {
  if (typeof response.body === 'string') return response.body.slice(0, 500);
  return response.body;
}
