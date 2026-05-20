#!/usr/bin/env node

import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);

function argValue(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const options = {
  json: args.includes('--json'),
  explain: !args.includes('--no-explain'),
  explainLimit: Number(argValue('--explain-limit', process.env.AUDIT_EXPLAIN_LIMIT ?? 8)),
  email: process.env.AUDIT_EMAIL ?? 'dev@ship.local',
  password: process.env.AUDIT_PASSWORD ?? 'admin123',
  searchTerm: process.env.AUDIT_SEARCH_TERM ?? 'audit',
};

process.env.NODE_ENV ??= 'development';

const writeStdout = process.stdout.write.bind(process.stdout);
if (options.json) {
  console.log = () => {};
  console.info = () => {};
}

const queryRecords = [];
let activeFlow = null;
let activeEndpoint = null;
let recordingEnabled = false;

function compactSql(sql) {
  return String(sql ?? '').replace(/\s+/g, ' ').trim();
}

function getQueryText(queryConfig) {
  if (typeof queryConfig === 'string') return queryConfig;
  if (queryConfig && typeof queryConfig.text === 'string') return queryConfig.text;
  return String(queryConfig ?? '');
}

function getQueryValues(queryConfig, values) {
  if (Array.isArray(values)) return values;
  if (queryConfig && Array.isArray(queryConfig.values)) return queryConfig.values;
  return [];
}

function fingerprintSql(sql) {
  return compactSql(sql)
    .replace(/\$\d+/g, '$?')
    .replace(/\b\d+\b/g, '?')
    .replace(/'[^']*'/g, "'?'");
}

function statementKind(sql) {
  const match = compactSql(sql).match(/^([a-z]+)/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function shouldRecord() {
  return recordingEnabled && activeFlow && activeEndpoint;
}

function recordQuery(queryConfig, values, startedAt, result, error) {
  if (!shouldRecord()) return;

  const text = getQueryText(queryConfig);
  const params = getQueryValues(queryConfig, values);
  queryRecords.push({
    flow: activeFlow,
    endpoint: activeEndpoint,
    sql: text,
    normalizedSql: compactSql(text),
    fingerprint: fingerprintSql(text),
    params,
    kind: statementKind(text),
    durationMs: performance.now() - startedAt,
    rowCount: result?.rowCount ?? null,
    error: error ? String(error.message ?? error) : null,
  });
}

const clientPatchSymbol = Symbol.for('ship.audit.queryEfficiency.clientPatched');

function patchClient(client) {
  if (client[clientPatchSymbol]) return client;

  const originalQuery = client.query.bind(client);

  client.query = function patchedClientQuery(queryConfig, values, callback) {
    const startedAt = performance.now();

    if (typeof values === 'function') {
      return originalQuery(queryConfig, (error, result) => {
        recordQuery(queryConfig, undefined, startedAt, result, error);
        values(error, result);
      });
    }

    if (typeof callback === 'function') {
      return originalQuery(queryConfig, values, (error, result) => {
        recordQuery(queryConfig, values, startedAt, result, error);
        callback(error, result);
      });
    }

    return originalQuery(queryConfig, values)
      .then((result) => {
        recordQuery(queryConfig, values, startedAt, result, null);
        return result;
      })
      .catch((error) => {
        recordQuery(queryConfig, values, startedAt, null, error);
        throw error;
      });
  };

  client[clientPatchSymbol] = true;
  return client;
}

function patchPool(pool) {
  const originalConnect = pool.connect.bind(pool);

  pool.connect = function patchedPoolConnect(callback) {
    if (typeof callback === 'function') {
      return originalConnect((error, client, done) => {
        callback(error, client ? patchClient(client) : client, done);
      });
    }

    return originalConnect().then((client) => patchClient(client));
  };
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const cookie = response.headers.get('set-cookie');
  return cookie ? [cookie] : [];
}

function cookieHeader(cookies) {
  const parts = new Map();
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [name, value] = pair.split('=');
    if (name && value) parts.set(name.trim(), value.trim());
  }
  return [...parts.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function readResponseBody(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function request(baseUrl, cookie, method, path, body) {
  activeEndpoint = `${method} ${path}`;
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    activeEndpoint = null;
    throw new Error(
      `${method} ${path} fetch failed: ${error.message ?? error}`
    );
  }
  const responseBody = await readResponseBody(response);
  activeEndpoint = null;

  if (!response.ok) {
    const renderedBody =
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    throw new Error(`${method} ${path} failed with ${response.status}: ${renderedBody}`);
  }

  return responseBody;
}

async function login(baseUrl) {
  let csrfResponse;
  try {
    csrfResponse = await fetch(`${baseUrl}/api/csrf-token`, {
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`GET /api/csrf-token fetch failed: ${error.message ?? error}`);
  }
  if (!csrfResponse.ok) {
    throw new Error(`GET /api/csrf-token failed with ${csrfResponse.status}`);
  }
  const csrfCookies = getSetCookies(csrfResponse);
  const csrf = await csrfResponse.json();

  let loginResponse;
  try {
    loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf.token,
        cookie: cookieHeader(csrfCookies),
      },
      body: JSON.stringify({ email: options.email, password: options.password }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`POST /api/auth/login fetch failed: ${error.message ?? error}`);
  }
  const loginBody = await readResponseBody(loginResponse);

  if (!loginResponse.ok) {
    const renderedBody = typeof loginBody === 'string' ? loginBody : JSON.stringify(loginBody);
    throw new Error(
      `Login failed for ${options.email} with ${loginResponse.status}: ${renderedBody}\n` +
        'Run `pnpm db:migrate && pnpm db:seed` against your local PostgreSQL database first.'
    );
  }

  return cookieHeader([...csrfCookies, ...getSetCookies(loginResponse)]);
}

async function getSampleDocumentId(pool) {
  const result = await pool.query(
    `SELECT id
     FROM documents
     WHERE document_type = 'wiki'
       AND archived_at IS NULL
       AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (!result.rows[0]) {
    throw new Error(
      'No wiki document found for the document-view flow. Run `pnpm db:seed` first.'
    );
  }

  return result.rows[0].id;
}

function appShellEndpoints() {
  return [
    ['GET', '/api/auth/me'],
    ['GET', '/api/auth/session'],
    ['GET', '/api/team/people?includeArchived=true'],
    ['GET', '/api/documents?type=wiki'],
    ['GET', '/api/programs'],
    ['GET', '/api/projects'],
    ['GET', '/api/issues'],
    ['GET', '/api/standups/status'],
    ['GET', '/api/accountability/action-items'],
  ];
}

function buildFlows(documentId) {
  return [
    {
      name: 'Load main page',
      endpoints: [...appShellEndpoints(), ['GET', '/api/dashboard/my-week']],
    },
    {
      name: 'View a document',
      endpoints: [
        ...appShellEndpoints(),
        ['GET', `/api/documents/${documentId}`],
        ['GET', '/api/team/people'],
        ['GET', `/api/documents/${documentId}/comments`],
      ],
    },
    {
      name: 'List issues',
      endpoints: [...appShellEndpoints()],
    },
    {
      name: 'Load sprint board',
      endpoints: [
        ...appShellEndpoints(),
        ['GET', '/api/team/grid'],
        ['GET', '/api/team/projects'],
        ['GET', '/api/team/assignments'],
      ],
    },
    {
      name: 'Search content',
      endpoints: [['GET', `/api/search/mentions?q=${encodeURIComponent(options.searchTerm)}`]],
    },
  ];
}

async function runFlow(baseUrl, cookie, flow) {
  activeFlow = flow.name;
  recordingEnabled = true;
  const startedIndex = queryRecords.length;

  if (!options.json) {
    console.error(`[audit] Running ${flow.name}`);
  }

  for (const [method, path] of flow.endpoints) {
    await request(baseUrl, cookie, method, path);
  }

  recordingEnabled = false;
  activeFlow = null;
  activeEndpoint = null;

  return queryRecords.slice(startedIndex);
}

function isExplainableSelect(record) {
  return (
    record.kind === 'SELECT' &&
    !/\bFOR\s+UPDATE\b/i.test(record.sql) &&
    !/\bpg_sleep\b/i.test(record.sql)
  );
}

function isAuthMaintenance(record) {
  const sql = record.normalizedSql;
  return (
    /FROM sessions s JOIN users u/i.test(sql) ||
    /UPDATE sessions SET last_activity/i.test(sql) ||
    /FROM workspace_memberships WHERE workspace_id/i.test(sql)
  );
}

function topExplainCandidates(records, limit) {
  const byFlow = new Map();
  const seen = new Set();
  const candidates = [];

  for (const record of records) {
    if (!isExplainableSelect(record) || isAuthMaintenance(record)) continue;
    const current = byFlow.get(record.flow);
    if (!current || record.durationMs > current.durationMs) {
      byFlow.set(record.flow, record);
    }
  }

  for (const record of byFlow.values()) {
    if (seen.has(record.fingerprint)) continue;
    seen.add(record.fingerprint);
    candidates.push(record);
  }

  const remaining = records
    .filter((record) => isExplainableSelect(record) && !isAuthMaintenance(record))
    .sort((a, b) => b.durationMs - a.durationMs);

  for (const record of remaining) {
    if (candidates.length >= limit) break;
    if (seen.has(record.fingerprint)) continue;
    seen.add(record.fingerprint);
    candidates.push(record);
  }

  return candidates.slice(0, limit);
}

function parseExplain(planText) {
  const executionTimeMatch = planText.match(/Execution Time: ([0-9.]+) ms/);
  const planningTimeMatch = planText.match(/Planning Time: ([0-9.]+) ms/);
  const loops = [...planText.matchAll(/loops=(\d+)/g)].map((match) => Number(match[1]));

  return {
    executionTimeMs: executionTimeMatch ? Number(executionTimeMatch[1]) : null,
    planningTimeMs: planningTimeMatch ? Number(planningTimeMatch[1]) : null,
    hasSeqScan: /\bSeq Scan on\b/i.test(planText),
    hasSubPlan: /\bSubPlan\b/i.test(planText),
    maxLoops: loops.length ? Math.max(...loops) : null,
  };
}

async function explainQueries(pool, candidates) {
  const explains = [];
  recordingEnabled = false;

  for (const record of candidates) {
    try {
      const result = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${record.sql}`,
        record.params
      );
      const planText = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      explains.push({
        flow: record.flow,
        endpoint: record.endpoint,
        observedMs: record.durationMs,
        sql: record.normalizedSql,
        planText,
        ...parseExplain(planText),
      });
    } catch (error) {
      explains.push({
        flow: record.flow,
        endpoint: record.endpoint,
        observedMs: record.durationMs,
        sql: record.normalizedSql,
        error: String(error.message ?? error),
      });
    }
  }

  return explains;
}

function repeatedQuerySignals(records) {
  const ignored = [
    /FROM sessions s JOIN users u/i,
    /UPDATE sessions SET last_activity/i,
    /SELECT role FROM workspace_memberships/i,
  ];
  const grouped = new Map();

  for (const record of records) {
    if (ignored.some((pattern) => pattern.test(record.normalizedSql))) continue;
    const key = `${record.endpoint} ${record.fingerprint}`;
    const entry = grouped.get(key) ?? {
      endpoint: record.endpoint,
      count: 0,
      sql: record.normalizedSql,
      totalMs: 0,
    };
    entry.count += 1;
    entry.totalMs += record.durationMs;
    grouped.set(key, entry);
  }

  return [...grouped.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count || b.totalMs - a.totalMs)
    .map((entry) => ({
      type: 'repeated-query',
      endpoint: entry.endpoint,
      count: entry.count,
      totalMs: entry.totalMs,
      sql: entry.sql,
    }));
}

function correlatedSubquerySignals(records, explainByFingerprint) {
  const signals = [];

  for (const record of records) {
    const sql = record.normalizedSql;
    const explain = explainByFingerprint.get(record.fingerprint);
    const queryLooksCorrelated =
      /\(SELECT COUNT\(\*\).*related_id = d\.id/is.test(sql) ||
      /WHERE sprint\.document_type = 'sprint'.*sprint\.workspace_id = d\.workspace_id.*= d\.id/is.test(
        sql
      );

    if (
      queryLooksCorrelated ||
      (explain?.hasSubPlan && Number(explain.maxLoops ?? 0) > 1)
    ) {
      signals.push({
        type: 'correlated-subplan',
        endpoint: record.endpoint,
        loops: explain?.maxLoops ?? null,
        observedMs: record.durationMs,
        sql,
      });
    }
  }

  return signals;
}

function flowMetrics(flowName, records, explainByFingerprint) {
  const slowest = records.reduce((current, record) => {
    if (!current || record.durationMs > current.durationMs) return record;
    return current;
  }, null);
  const signals = [
    ...repeatedQuerySignals(records),
    ...correlatedSubquerySignals(records, explainByFingerprint),
  ];

  return {
    userFlow: flowName,
    totalQueries: records.length,
    slowestQueryMs: slowest ? Number(slowest.durationMs.toFixed(2)) : 0,
    slowestEndpoint: slowest?.endpoint ?? null,
    slowestSql: slowest?.normalizedSql ?? null,
    nPlusOneDetected: signals.length > 0,
    nPlusOneSignals: signals,
  };
}

function endpointSummaries(records) {
  const grouped = new Map();
  for (const record of records) {
    const entry = grouped.get(record.endpoint) ?? {
      endpoint: record.endpoint,
      queryCount: 0,
      totalMs: 0,
      slowestMs: 0,
    };
    entry.queryCount += 1;
    entry.totalMs += record.durationMs;
    entry.slowestMs = Math.max(entry.slowestMs, record.durationMs);
    grouped.set(record.endpoint, entry);
  }

  return [...grouped.values()].map((entry) => ({
    ...entry,
    totalMs: Number(entry.totalMs.toFixed(2)),
    slowestMs: Number(entry.slowestMs.toFixed(2)),
  }));
}

async function collectIndexHints(pool, records) {
  const [indexesResult, extensionsResult] = await Promise.all([
    pool.query(
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY tablename, indexname`
    ),
    pool.query(`SELECT extname FROM pg_extension`),
  ]);

  const indexes = indexesResult.rows;
  const indexText = indexes.map((row) => `${row.indexname} ${row.indexdef}`).join('\n');
  const extensions = new Set(extensionsResult.rows.map((row) => row.extname));
  const sqlText = records.map((record) => record.normalizedSql).join('\n');
  const hints = [];

  if (
    /ORDER BY position ASC, created_at DESC/i.test(sqlText) &&
    !/workspace_id,\s*document_type,\s*position/i.test(indexText)
  ) {
    hints.push({
      queryPattern: 'wiki/document list ordering',
      finding:
        'No active documents index appears to cover workspace_id, document_type, position, created_at.',
      candidate:
        'CREATE INDEX IF NOT EXISTS idx_documents_active_type_position ON documents (workspace_id, document_type, position ASC, created_at DESC) WHERE archived_at IS NULL AND deleted_at IS NULL;',
    });
  }

  if (
    /title ILIKE/i.test(sqlText) &&
    (!extensions.has('pg_trgm') || !/gin_trgm_ops/i.test(indexText))
  ) {
    hints.push({
      queryPattern: 'title ILIKE search',
      finding: 'Search uses leading-wildcard ILIKE without a detected trigram title index.',
      candidate:
        'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops) WHERE deleted_at IS NULL;',
    });
  }

  if (
    /properties->>'project_id'.*properties->>'sprint_number'|properties->>'sprint_number'.*properties->>'project_id'/is.test(
      sqlText
    ) &&
    !/idx_documents_sprint_project_week|properties->>'project_id'.*properties->>'sprint_number'/is.test(
      indexText
    )
  ) {
    hints.push({
      queryPattern: 'sprint lookup by properties.project_id and sprint_number',
      finding: 'Sprint lookup is backed by JSONB extraction but no matching expression index was detected.',
      candidate:
        "CREATE INDEX IF NOT EXISTS idx_documents_sprint_project_week ON documents (workspace_id, ((NULLIF(properties->>'project_id', ''))::uuid), (((properties->>'sprint_number')::int))) WHERE document_type = 'sprint' AND deleted_at IS NULL;",
    });
  }

  if (
    /properties->>'person_id'.*properties->>'project_id'.*properties->>'week_number'/is.test(
      sqlText
    ) &&
    !/idx_documents_weekly_(plan|retro)_lookup|properties->>'person_id'.*properties->>'project_id'.*properties->>'week_number'/is.test(
      indexText
    )
  ) {
    hints.push({
      queryPattern: 'weekly plan/retro lookup by person, project, week',
      finding: 'Weekly accountability lookups use JSONB fields without a detected composite expression index.',
      candidate:
        "CREATE INDEX IF NOT EXISTS idx_documents_weekly_plan_lookup ON documents (workspace_id, (properties->>'person_id'), (properties->>'project_id'), (((properties->>'week_number')::int))) WHERE document_type = 'weekly_plan' AND archived_at IS NULL AND deleted_at IS NULL;",
    });
  }

  return hints;
}

function markdownTable(metrics) {
  const lines = [
    '| User Flow | Total Queries | Slowest Query (ms) | N+1 Detected? |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const row of metrics) {
    lines.push(
      `| ${row.userFlow} | ${row.totalQueries} | ${row.slowestQueryMs.toFixed(2)}ms | ${
        row.nPlusOneDetected ? 'Yes' : 'No'
      } |`
    );
  }
  return lines.join('\n');
}

function renderMarkdown(result) {
  const lines = [];

  lines.push('# Database Query Efficiency Audit Run');
  lines.push('');
  lines.push(`Database: ${result.database.redactedUrl}`);
  lines.push(`Authenticated user: ${result.user}`);
  lines.push(`Sample document: ${result.sampleDocumentId}`);
  lines.push('');
  lines.push('## Audit Deliverable');
  lines.push('');
  lines.push(markdownTable(result.metrics));
  lines.push('');
  lines.push('## Slowest Query Details');
  lines.push('');

  for (const metric of result.metrics) {
    lines.push(
      `- ${metric.userFlow}: ${metric.slowestQueryMs.toFixed(2)}ms at ${metric.slowestEndpoint}`
    );
  }

  if (result.explains.length > 0) {
    lines.push('');
    lines.push('## EXPLAIN ANALYZE Summary');
    lines.push('');
    for (const explain of result.explains) {
      if (explain.error) {
        lines.push(`- ${explain.endpoint}: EXPLAIN failed: ${explain.error}`);
      } else {
        const flags = [
          explain.hasSeqScan ? 'seq scan' : null,
          explain.hasSubPlan ? `subplan loops=${explain.maxLoops}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(
          `- ${explain.endpoint}: observed ${explain.observedMs.toFixed(2)}ms, plan execution ${
            explain.executionTimeMs?.toFixed(3) ?? 'n/a'
          }ms${flags ? ` (${flags})` : ''}`
        );
      }
    }
  }

  const nPlusOneRows = result.metrics.filter((metric) => metric.nPlusOneDetected);
  if (nPlusOneRows.length > 0) {
    lines.push('');
    lines.push('## N+1 Signals');
    lines.push('');
    for (const metric of nPlusOneRows) {
      const signal = metric.nPlusOneSignals[0];
      lines.push(
        `- ${metric.userFlow}: ${signal.type} at ${signal.endpoint}${
          signal.count ? ` (${signal.count} repeated executions)` : ''
        }${signal.loops ? ` (max loops=${signal.loops})` : ''}`
      );
    }
  }

  if (result.indexHints.length > 0) {
    lines.push('');
    lines.push('## Index Gap Hints');
    lines.push('');
    for (const hint of result.indexHints) {
      lines.push(`- ${hint.queryPattern}: ${hint.finding}`);
    }
  }

  lines.push('');
  lines.push('Use `--json` for full endpoint, SQL, EXPLAIN, and index details.');
  return lines.join('\n');
}

function redactDatabaseUrl(connectionString) {
  if (!connectionString) return '(DATABASE_URL not set)';
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username ? '***' : '';
    return url.toString();
  } catch {
    return '(DATABASE_URL present but not parseable)';
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine audit server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;

  const closePromise = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  server.closeIdleConnections?.();
  server.closeAllConnections?.();

  await closePromise;
}

async function cleanupWithTimeout(label, promise, timeoutMs = 3000) {
  let timeoutId;
  let timedOut = false;
  const guarded = Promise.resolve(promise).catch((error) => {
    if (!options.json) {
      console.error(`[audit] ${label} cleanup failed: ${error.message ?? error}`);
    }
  });

  await Promise.race([
    guarded,
    new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);

  clearTimeout(timeoutId);
  if (timedOut && !options.json) {
    console.error(`[audit] ${label} cleanup timed out; forcing CLI exit`);
  }
}

async function main() {
  const { pool } = await import('../../api/src/db/client.ts');
  patchPool(pool);
  const { createApp } = await import('../../api/src/app.ts');

  const app = createApp('http://localhost:5173');
  const server = createServer(app);

  try {
    const baseUrl = await listen(server);
    const sampleDocumentId = await getSampleDocumentId(pool);
    const cookie = await login(baseUrl);
    const flows = buildFlows(sampleDocumentId);
    const flowRecordMap = new Map();

    for (const flow of flows) {
      const records = await runFlow(baseUrl, cookie, flow);
      flowRecordMap.set(flow.name, records);
    }

    const explainCandidates = options.explain
      ? topExplainCandidates(queryRecords, options.explainLimit)
      : [];
    const explains = options.explain ? await explainQueries(pool, explainCandidates) : [];
    const explainByFingerprint = new Map(
      explains.map((explain) => [
        fingerprintSql(explain.sql),
        explain,
      ])
    );

    const metrics = flows.map((flow) =>
      flowMetrics(flow.name, flowRecordMap.get(flow.name) ?? [], explainByFingerprint)
    );
    const indexHints = await collectIndexHints(pool, queryRecords);
    const result = {
      generatedAt: new Date().toISOString(),
      user: options.email,
      sampleDocumentId,
      database: {
        redactedUrl: redactDatabaseUrl(process.env.DATABASE_URL),
      },
      metrics,
      endpointSummaries: Object.fromEntries(
        flows.map((flow) => [flow.name, endpointSummaries(flowRecordMap.get(flow.name) ?? [])])
      ),
      explains,
      indexHints,
    };

    if (options.json) {
      writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeStdout(`${renderMarkdown(result)}\n`);
    }
  } finally {
    await cleanupWithTimeout('server', closeServer(server));
    await cleanupWithTimeout('database pool', pool.end());
  }
}

main().then(
  () => {
    process.stdout.write('', () => {
      process.stderr.write('', () => process.exit(0));
    });
  },
  (error) => {
    console.error(error.stack ?? error);
    process.exit(1);
  }
);
