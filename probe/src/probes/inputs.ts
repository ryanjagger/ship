import { randomUUID } from 'node:crypto';
import type { ProbeConfig } from '../config.js';
import { ProbeHttpClient, responseBodyPath, type CookieMetadata, type ProbeResponse } from '../http-client.js';
import { finding, notTested, pass, type ProbeCheck } from '../report.js';

type InputFixture = {
  marker: string;
  xssPayload: string;
  document?: { id: string; title: string };
  issue?: { id: string; title: string };
  comment?: { id: string; commentId: string; content: string };
};

type EndpointProbeResult = {
  endpoint: string;
  payloadLabel: string;
  status: number;
  ok: boolean;
  bodyPreview: string;
  reflectedPayload: boolean;
  verboseError: boolean;
};

const SQL_PAYLOADS = [
  { label: 'single-quote-or-true', value: "' OR '1'='1" },
  { label: 'union-select', value: "' UNION SELECT NULL,NULL,NULL--" },
  { label: 'stacked-statement', value: "'); SELECT pg_sleep(1); --" },
  { label: 'line-comment', value: "probe'--" },
];

const REFLECTED_XSS_PAYLOAD = '<svg/onload=window.__shipProbeReflectedXss=1>';
const MAX_PREVIEW = 500;

export async function runInputProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const client = new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`);

  const loginResponse = await client.login(config.email, config.password);
  if (!loginResponse.ok) {
    return [
      notTested('inputs.authenticated_cases', 'Input sanitization probes require successful login', 'inputs', {
        loginStatus: loginResponse.status,
        body: compactBody(loginResponse),
        email: config.email,
      }),
    ];
  }

  if (!config.allowMutation) {
    return [
      notTested('inputs.mutating_cases', 'Input sanitization probes require --allow-mutation', 'inputs', {
        allowMutation: false,
        reason: 'The probe creates dedicated wiki, issue, and comment fixtures containing attack payloads.',
      }),
    ];
  }

  const fixture = await createInputFixture(config, client);
  if ('check' in fixture) {
    checks.push(fixture.check);
    checks.push(...inputNotTestedAfterFixtureFailure());
    return checks;
  }

  checks.push(pass('inputs.fixture.created', 'Input sanitization fixtures were created', 'inputs', fixture.evidence, [
    `POST ${config.apiUrl}/api/documents with XSS canaries in title/content`,
    `POST ${config.apiUrl}/api/issues with XSS canary in title`,
    `POST ${config.apiUrl}/api/documents/:id/comments with XSS canary in content`,
  ]));

  const inputFixture = fixture.fixture;
  checks.push(await checkStoredVectorsApi(config, client, inputFixture));
  checks.push(await checkStoredXssInBrowser(config, client.cookies.get('session_id'), inputFixture));
  checks.push(await checkReflectedXss(config, client, inputFixture));
  checks.push(await checkSqlInjection(config, client, inputFixture));
  checks.push(await checkLongInputRejection(config, client, inputFixture));

  if (config.keepData) {
    checks.push(notTested('inputs.fixture.cleanup', 'Input sanitization fixture cleanup skipped because --keep-data was set', 'inputs', {
      fixture: fixtureSummary(inputFixture),
    }));
  } else {
    checks.push(await cleanupInputFixture(config, client, inputFixture));
  }

  return checks;
}

async function createInputFixture(
  config: ProbeConfig,
  client: ProbeHttpClient
): Promise<{ fixture: InputFixture; evidence: unknown } | { check: ProbeCheck }> {
  const marker = stableMarker(config.runId);
  const xssPayload = `<img src=x onerror="window.__shipProbeXssHits=(window.__shipProbeXssHits||[]);window.__shipProbeXssHits.push('${marker}')">`;
  const documentTitle = `${marker} document title ${xssPayload}`;
  const documentText = `${marker} document body ${xssPayload}`;
  const issueTitle = `${marker} issue title ${xssPayload}`;
  const commentId = randomUUID();
  const commentContent = `${marker} comment body ${xssPayload}`;

  const documentResponse = await client.request('/api/documents', {
    method: 'POST',
    csrf: true,
    body: {
      title: documentTitle,
      document_type: 'wiki',
      visibility: 'workspace',
      content: tiptapDoc(documentText),
      properties: {
        probe_run_id: config.runId,
        tags: ['probe', 'security-input'],
      },
    },
  });

  const documentId = stringPath(documentResponse, ['id']);
  if (!documentResponse.ok || !documentId) {
    return {
      check: finding('inputs.fixture.document', 'Could not create document fixture for input probes', 'inputs', 'high', {
        status: documentResponse.status,
        body: compactBody(documentResponse),
      }, [
        `POST ${config.apiUrl}/api/documents with XSS canaries in title/content`,
      ]),
    };
  }

  const issueResponse = await client.request('/api/issues', {
    method: 'POST',
    csrf: true,
    body: {
      title: issueTitle,
      state: 'backlog',
      priority: 'medium',
      source: 'internal',
    },
  });

  const issueId = stringPath(issueResponse, ['id']);
  if (!issueResponse.ok || !issueId) {
    await client.request(`/api/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', csrf: true });
    return {
      check: finding('inputs.fixture.issue', 'Could not create issue fixture for input probes', 'inputs', 'high', {
        status: issueResponse.status,
        body: compactBody(issueResponse),
      }, [
        `POST ${config.apiUrl}/api/issues with XSS canary in title`,
      ]),
    };
  }

  const commentResponse = await client.request(`/api/documents/${encodeURIComponent(documentId)}/comments`, {
    method: 'POST',
    csrf: true,
    body: {
      comment_id: commentId,
      content: commentContent,
    },
  });

  const commentPrimaryId = stringPath(commentResponse, ['id']);
  if (!commentResponse.ok || !commentPrimaryId) {
    await client.request(`/api/issues/${encodeURIComponent(issueId)}`, { method: 'DELETE', csrf: true });
    await client.request(`/api/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', csrf: true });
    return {
      check: finding('inputs.fixture.comment', 'Could not create comment fixture for input probes', 'inputs', 'high', {
        status: commentResponse.status,
        body: compactBody(commentResponse),
      }, [
        `POST ${config.apiUrl}/api/documents/${documentId}/comments with XSS canary in content`,
      ]),
    };
  }

  const fixture: InputFixture = {
    marker,
    xssPayload,
    document: { id: documentId, title: documentTitle },
    issue: { id: issueId, title: issueTitle },
    comment: { id: commentPrimaryId, commentId, content: commentContent },
  };

  return {
    fixture,
    evidence: {
      marker,
      document: { id: documentId, titleLength: documentTitle.length },
      issue: { id: issueId, titleLength: issueTitle.length },
      comment: { id: commentPrimaryId, contentLength: commentContent.length },
      payloadClasses: ['stored-xss-title', 'stored-xss-content', 'stored-xss-comment'],
    },
  };
}

async function checkStoredVectorsApi(config: ProbeConfig, client: ProbeHttpClient, fixture: InputFixture): Promise<ProbeCheck> {
  if (!fixture.document || !fixture.issue || !fixture.comment) {
    return notTested('inputs.stored_vectors.api', 'Stored input vectors require complete fixtures', 'inputs', {
      fixture: fixtureSummary(fixture),
    });
  }

  const documentResponse = await client.request(`/api/documents/${encodeURIComponent(fixture.document.id)}`);
  const contentResponse = await client.request(`/api/documents/${encodeURIComponent(fixture.document.id)}/content`);
  const issueResponse = await client.request(`/api/issues?state=backlog`);
  const commentsResponse = await client.request(`/api/documents/${encodeURIComponent(fixture.document.id)}/comments`);

  const results = [
    {
      name: 'document',
      status: documentResponse.status,
      ok: documentResponse.ok,
      containsMarker: documentResponse.bodyText.includes(fixture.marker),
      containsPayload: documentResponse.bodyText.includes(fixture.xssPayload),
      verboseError: hasVerboseServerError(documentResponse.bodyText),
    },
    {
      name: 'document-content',
      status: contentResponse.status,
      ok: contentResponse.ok,
      containsMarker: contentResponse.bodyText.includes(fixture.marker),
      containsPayload: contentResponse.bodyText.includes(fixture.xssPayload),
      verboseError: hasVerboseServerError(contentResponse.bodyText),
    },
    {
      name: 'issue-list',
      status: issueResponse.status,
      ok: issueResponse.ok,
      containsMarker: issueResponse.bodyText.includes(fixture.marker),
      containsPayload: issueResponse.bodyText.includes(fixture.xssPayload),
      verboseError: hasVerboseServerError(issueResponse.bodyText),
    },
    {
      name: 'comments',
      status: commentsResponse.status,
      ok: commentsResponse.ok,
      containsMarker: commentsResponse.bodyText.includes(fixture.marker),
      containsPayload: commentsResponse.bodyText.includes(fixture.xssPayload),
      verboseError: hasVerboseServerError(commentsResponse.bodyText),
    },
  ];

  const failures = results.filter((result) => !result.ok || result.verboseError || !result.containsMarker);
  if (failures.length > 0) {
    return finding('inputs.stored_vectors.api', 'Stored input vectors did not round-trip safely through API reads', 'inputs', 'high', {
      fixture: fixtureSummary(fixture),
      failures,
      results,
    }, [
      `Create document, issue, and comment containing marker ${fixture.marker}`,
      `GET ${config.apiUrl}/api/documents/${fixture.document.id}`,
      `GET ${config.apiUrl}/api/documents/${fixture.document.id}/content`,
      `GET ${config.apiUrl}/api/issues?state=backlog`,
      `GET ${config.apiUrl}/api/documents/${fixture.document.id}/comments`,
    ]);
  }

  return pass('inputs.stored_vectors.api', 'Stored input vectors are retrievable without server errors', 'inputs', {
    fixture: fixtureSummary(fixture),
    results,
    note: 'Raw payloads in JSON API responses are treated as data. Browser execution is tested separately when web-url and Playwright are available.',
  }, [
    `Create document, issue, and comment containing marker ${fixture.marker}`,
    'Read those fields back through representative API endpoints',
  ]);
}

async function checkStoredXssInBrowser(
  config: ProbeConfig,
  sessionCookie: CookieMetadata | undefined,
  fixture: InputFixture
): Promise<ProbeCheck> {
  if (!config.webUrl) {
    return notTested('inputs.stored_xss.browser', 'Stored XSS browser execution probe requires --web-url', 'inputs', {
      fixture: fixtureSummary(fixture),
    });
  }

  if (!fixture.document || !sessionCookie) {
    return notTested('inputs.stored_xss.browser', 'Stored XSS browser execution probe requires a document fixture and session cookie', 'inputs', {
      fixture: fixtureSummary(fixture),
      sessionCookiePresent: Boolean(sessionCookie),
    });
  }

  let chromium: typeof import('@playwright/test')['chromium'];
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch (error) {
    return notTested('inputs.stored_xss.browser', 'Stored XSS browser execution probe requires @playwright/test', 'inputs', {
      fixture: fixtureSummary(fixture),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const browserHits: string[] = [];
  const dialogs: Array<{ type: string; message: string }> = [];
  const pageErrors: string[] = [];

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([{
      name: sessionCookie.name,
      value: sessionCookie.value,
      domain: new URL(config.apiUrl).hostname,
      path: '/',
      httpOnly: true,
      secure: config.apiUrl.startsWith('https://'),
      sameSite: normalizeSameSite(sessionCookie.attributes.samesite),
    }]);

    const page = await context.newPage();
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss().catch(() => {});
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await page.addInitScript(() => {
      const hits: string[] = [];
      Object.defineProperty(window, '__shipProbeXssHits', {
        configurable: true,
        get: () => hits,
        set: (value) => hits.push(String(value)),
      });
      const recordDialog = (kind: string) => (message?: unknown) => {
        hits.push(`${kind}:${String(message ?? '')}`);
      };
      window.alert = recordDialog('alert');
      window.confirm = ((message?: unknown) => {
        hits.push(`confirm:${String(message ?? '')}`);
        return false;
      }) as typeof window.confirm;
      window.prompt = ((message?: unknown) => {
        hits.push(`prompt:${String(message ?? '')}`);
        return null;
      }) as typeof window.prompt;
    });

    const targetUrl = `${config.webUrl.replace(/\/+$/, '')}/documents/${fixture.document.id}`;
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    const evaluatedHits = await page.evaluate(() => {
      return Array.isArray(window.__shipProbeXssHits) ? window.__shipProbeXssHits.map(String) : [];
    });
    browserHits.push(...evaluatedHits);

    const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    const markerVisible = bodyText.includes(fixture.marker);

    if (browserHits.length > 0 || dialogs.length > 0) {
      return finding('inputs.stored_xss.browser', 'Stored XSS payload executed in the web app', 'inputs', 'critical', {
        fixture: fixtureSummary(fixture),
        targetUrl,
        finalUrl,
        status,
        markerVisible,
        browserHits,
        dialogs,
        pageErrors,
      }, [
        `Create a wiki document whose title/content includes ${fixture.xssPayload}`,
        `Open ${targetUrl} in an authenticated browser session`,
        'Observe script execution via alert/prompt/confirm or the probe marker array',
      ]);
    }

    if (!markerVisible) {
      return notTested('inputs.stored_xss.browser', 'Stored XSS browser execution probe could not confirm the fixture rendered', 'inputs', {
        fixture: fixtureSummary(fixture),
        targetUrl,
        finalUrl,
        status,
        bodyPreview: bodyText.slice(0, MAX_PREVIEW),
        pageErrors,
      });
    }

    return pass('inputs.stored_xss.browser', 'Stored XSS payload did not execute in browser-rendered document', 'inputs', {
      fixture: fixtureSummary(fixture),
      targetUrl,
      finalUrl,
      status,
      markerVisible,
      browserHits,
      dialogs,
      pageErrors,
    }, [
      `Create a wiki document whose title/content includes ${fixture.xssPayload}`,
      `Open ${targetUrl} in an authenticated browser session`,
      'Confirm no alert/prompt/confirm or marker-array execution occurred',
    ]);
  } catch (error) {
    return notTested('inputs.stored_xss.browser', 'Stored XSS browser execution probe could not run', 'inputs', {
      fixture: fixtureSummary(fixture),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function checkReflectedXss(config: ProbeConfig, client: ProbeHttpClient, fixture: InputFixture): Promise<ProbeCheck> {
  const payload = `${fixture.marker}-${REFLECTED_XSS_PAYLOAD}`;
  const endpoints = [
    `/api/search/mentions?q=${encodeURIComponent(payload)}`,
    `/api/search/learnings?q=${encodeURIComponent(payload)}`,
    `/api/documents?type=${encodeURIComponent(payload)}`,
    `/api/issues?state=${encodeURIComponent(payload)}`,
  ];

  const results: EndpointProbeResult[] = [];
  for (const endpoint of endpoints) {
    const response = await client.request(endpoint);
    results.push(endpointResult(endpoint, 'reflected-xss', payload, response));
  }

  const reflected = results.filter((result) => result.reflectedPayload);
  const unsafeResponses = results.filter((result) => result.status >= 500 || result.status === 0 || result.verboseError);

  if (reflected.length > 0) {
    return finding('inputs.reflected_xss.query_params', 'Reflected XSS payload was reflected by a representative endpoint', 'inputs', 'high', {
      payload,
      reflected,
      unsafeResponses,
      results,
    }, endpoints.map((endpoint) => `GET ${config.apiUrl}${endpoint}`));
  }

  return pass('inputs.reflected_xss.query_params', 'Reflected XSS query payloads were not reflected by representative endpoints', 'inputs', {
    payload,
    unsafeResponses,
    results,
  }, endpoints.map((endpoint) => `GET ${config.apiUrl}${endpoint}`));
}

async function checkSqlInjection(config: ProbeConfig, client: ProbeHttpClient, fixture: InputFixture): Promise<ProbeCheck> {
  const endpoints = [
    (payload: string) => `/api/search/mentions?q=${encodeURIComponent(payload)}`,
    (payload: string) => `/api/search/learnings?q=${encodeURIComponent(payload)}`,
    (payload: string) => `/api/documents?type=${encodeURIComponent(payload)}`,
    (payload: string) => `/api/issues?state=${encodeURIComponent(payload)}`,
  ];

  const results: EndpointProbeResult[] = [];
  for (const payload of SQL_PAYLOADS) {
    for (const endpoint of endpoints) {
      const path = endpoint(payload.value);
      const response = await client.request(path, { timeoutMs: Math.min(config.timeoutMs, 10_000) });
      results.push(endpointResult(path, payload.label, payload.value, response));
    }
  }

  const wildcardEndpoint = `/api/search/mentions?q=${encodeURIComponent('%')}`;
  const wildcardResponse = await client.request(wildcardEndpoint);
  const wildcardMatchedCanary = wildcardResponse.bodyText.includes(fixture.marker);

  const failures = results.filter((result) => result.status >= 500 || result.status === 0 || result.verboseError);
  if (failures.length > 0 || wildcardMatchedCanary) {
    return finding('inputs.sql_injection.query_params', 'SQL injection payloads caused database errors or broad wildcard matching', 'inputs', failures.length > 0 ? 'high' : 'medium', {
      failures,
      wildcardCheck: {
        endpoint: wildcardEndpoint,
        status: wildcardResponse.status,
        wildcardMatchedCanary,
        bodyPreview: wildcardResponse.bodyText.slice(0, MAX_PREVIEW),
      },
      results,
    }, [
      ...SQL_PAYLOADS.flatMap((payload) => endpoints.map((endpoint) => `GET ${config.apiUrl}${endpoint(payload.value)}`)),
      `GET ${config.apiUrl}${wildcardEndpoint}`,
    ]);
  }

  return pass('inputs.sql_injection.query_params', 'SQL injection query payloads were contained by representative endpoints', 'inputs', {
    testedPayloads: SQL_PAYLOADS.map((payload) => payload.label),
    results,
    wildcardCheck: {
      endpoint: wildcardEndpoint,
      status: wildcardResponse.status,
      wildcardMatchedCanary,
    },
  }, [
    ...SQL_PAYLOADS.flatMap((payload) => endpoints.map((endpoint) => `GET ${config.apiUrl}${endpoint(payload.value)}`)),
    `GET ${config.apiUrl}${wildcardEndpoint}`,
  ]);
}

async function checkLongInputRejection(config: ProbeConfig, client: ProbeHttpClient, fixture: InputFixture): Promise<ProbeCheck> {
  if (!fixture.document) {
    return notTested('inputs.long_input.validation', 'Long input validation requires a document fixture for comment checks', 'inputs', {
      fixture: fixtureSummary(fixture),
    });
  }

  const longDocumentTitle = `${fixture.marker}-${'d'.repeat(5_000)}`;
  const longIssueTitle = `${fixture.marker}-${'i'.repeat(2_000)}`;
  const longComment = `${fixture.marker}-${'c'.repeat(20_000)}`;

  const cases = [
    {
      name: 'document-title',
      maxExpected: 255,
      response: await client.request('/api/documents', {
        method: 'POST',
        csrf: true,
        body: {
          title: longDocumentTitle,
          document_type: 'wiki',
          visibility: 'workspace',
        },
      }),
      reproduction: `POST ${config.apiUrl}/api/documents with a ${longDocumentTitle.length}-character title`,
    },
    {
      name: 'issue-title',
      maxExpected: 500,
      response: await client.request('/api/issues', {
        method: 'POST',
        csrf: true,
        body: {
          title: longIssueTitle,
          state: 'backlog',
          priority: 'medium',
        },
      }),
      reproduction: `POST ${config.apiUrl}/api/issues with a ${longIssueTitle.length}-character title`,
    },
    {
      name: 'comment-content',
      maxExpected: 10_000,
      response: await client.request(`/api/documents/${encodeURIComponent(fixture.document.id)}/comments`, {
        method: 'POST',
        csrf: true,
        body: {
          comment_id: randomUUID(),
          content: longComment,
        },
      }),
      reproduction: `POST ${config.apiUrl}/api/documents/${fixture.document.id}/comments with a ${longComment.length}-character comment`,
    },
  ];

  const results = cases.map((testCase) => ({
    name: testCase.name,
    status: testCase.response.status,
    ok: testCase.response.ok,
    maxExpected: testCase.maxExpected,
    body: compactBody(testCase.response),
  }));

  const accepted = results.filter((result) => result.status >= 200 && result.status < 300);
  const serverErrors = results.filter((result) => result.status >= 500 || result.status === 0);
  if (accepted.length > 0 || serverErrors.length > 0) {
    return finding('inputs.long_input.validation', 'Excessively long user-facing input was accepted or crashed an endpoint', 'inputs', accepted.length > 0 ? 'high' : 'medium', {
      accepted,
      serverErrors,
      results,
    }, cases.map((testCase) => testCase.reproduction));
  }

  return pass('inputs.long_input.validation', 'Excessively long user-facing input is rejected without server errors', 'inputs', {
    results,
  }, cases.map((testCase) => testCase.reproduction));
}

async function cleanupInputFixture(config: ProbeConfig, client: ProbeHttpClient, fixture: InputFixture): Promise<ProbeCheck> {
  const results: Array<{ target: string; id?: string; status: number; ok: boolean; body: unknown }> = [];

  if (fixture.comment?.id) {
    const response = await client.request(`/api/comments/${encodeURIComponent(fixture.comment.id)}`, {
      method: 'DELETE',
      csrf: true,
    });
    results.push({ target: 'comment', id: fixture.comment.id, status: response.status, ok: response.ok, body: compactBody(response) });
  }

  if (fixture.issue?.id) {
    const response = await client.request(`/api/issues/${encodeURIComponent(fixture.issue.id)}`, {
      method: 'DELETE',
      csrf: true,
    });
    results.push({ target: 'issue', id: fixture.issue.id, status: response.status, ok: response.ok || response.status === 404, body: compactBody(response) });
  }

  if (fixture.document?.id) {
    const response = await client.request(`/api/documents/${encodeURIComponent(fixture.document.id)}`, {
      method: 'DELETE',
      csrf: true,
    });
    results.push({ target: 'document', id: fixture.document.id, status: response.status, ok: response.ok || response.status === 204 || response.status === 404, body: compactBody(response) });
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return finding('inputs.fixture.cleanup', 'Input sanitization fixture cleanup failed', 'inputs', 'medium', {
      fixture: fixtureSummary(fixture),
      failures,
      results,
    }, [
      'DELETE generated comment, issue, and document fixtures',
    ]);
  }

  return pass('inputs.fixture.cleanup', 'Input sanitization fixtures were cleaned up', 'inputs', {
    fixture: fixtureSummary(fixture),
    results,
  }, [
    'DELETE generated comment, issue, and document fixtures',
  ]);
}

function endpointResult(endpoint: string, payloadLabel: string, payload: string, response: ProbeResponse): EndpointProbeResult {
  return {
    endpoint,
    payloadLabel,
    status: response.status,
    ok: response.ok,
    bodyPreview: response.bodyText.slice(0, MAX_PREVIEW),
    reflectedPayload: response.bodyText.includes(payload),
    verboseError: hasVerboseServerError(response.bodyText),
  };
}

function hasVerboseServerError(bodyText: string): boolean {
  return /syntax error|unterminated quoted string|invalid input syntax|SQLSTATE|Postgres|PostgreSQL|pg_query|stack trace|node_modules|at\s+\S+\s+\(/i.test(bodyText);
}

function inputNotTestedAfterFixtureFailure(): ProbeCheck[] {
  return [
    notTested('inputs.stored_vectors.api', 'Stored input vector checks require generated fixtures', 'inputs', {}),
    notTested('inputs.stored_xss.browser', 'Stored XSS browser execution checks require generated fixtures', 'inputs', {}),
    notTested('inputs.reflected_xss.query_params', 'Reflected XSS query checks require generated fixtures', 'inputs', {}),
    notTested('inputs.sql_injection.query_params', 'SQL injection query checks require generated fixtures', 'inputs', {}),
    notTested('inputs.long_input.validation', 'Long input checks require generated fixtures', 'inputs', {}),
  ];
}

function tiptapDoc(text: string): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function stableMarker(runId: string): string {
  return `ship_probe_${runId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function fixtureSummary(fixture: InputFixture): unknown {
  return {
    marker: fixture.marker,
    documentId: fixture.document?.id,
    issueId: fixture.issue?.id,
    commentId: fixture.comment?.id,
  };
}

function normalizeSameSite(value: string | true | undefined): 'Strict' | 'Lax' | 'None' {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'none') return 'None';
  if (normalized === 'lax') return 'Lax';
  return 'Strict';
}

function stringPath(response: ProbeResponse, path: string[]): string | undefined {
  const value = responseBodyPath(response, path);
  return typeof value === 'string' ? value : undefined;
}

function compactBody(response: ProbeResponse): unknown {
  if (typeof response.body === 'string') return response.body.slice(0, MAX_PREVIEW);
  if (response.body && typeof response.body === 'object') return response.body;
  return response.body;
}

declare global {
  interface Window {
    __shipProbeXssHits?: string[];
  }
}
