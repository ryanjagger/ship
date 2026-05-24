import type { ProbeConfig } from '../config.js';
import { CookieMetadata, ProbeHttpClient, responseBodyPath } from '../http-client.js';
import { finding, notTested, pass, type ProbeCheck } from '../report.js';

type CreatedRoleUser = {
  role: 'admin' | 'member';
  email: string;
  userId: string;
  client: ProbeHttpClient;
  sessionCookie?: CookieMetadata;
};

const GENERATED_PASSWORD = 'ProbePassword123!';

export async function runAuthProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const userAgent = `ship-probe/${config.runId}`;
  const client = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);

  checks.push(await checkHealth(config, client));
  checks.push(await checkCsrf(client));

  const loginResponse = await client.login(config.email, config.password);
  if (!loginResponse.ok) {
    checks.push(finding(
      'auth.login.default_credentials',
      'Default or configured credentials could not log in',
      'auth',
      'critical',
      {
        status: loginResponse.status,
        body: loginResponse.body,
        email: config.email,
      },
      [
        `GET ${config.apiUrl}/api/csrf-token`,
        `POST ${config.apiUrl}/api/auth/login with the configured email and password`,
      ]
    ));
    checks.push(...authNotTestedAfterLoginFailure());
    return checks;
  }

  checks.push(pass(
    'auth.login.default_credentials',
    'Default or configured credentials can log in',
    'auth',
    { status: loginResponse.status, email: config.email },
    [
      `GET ${config.apiUrl}/api/csrf-token`,
      `POST ${config.apiUrl}/api/auth/login with the configured email and password`,
    ]
  ));

  checks.push(checkSessionCookie(config, client.cookies.get('session_id'), 'auth.session.cookie_login', 'Login session cookie is hardened'));

  const meResponse = await client.request('/api/auth/me');
  const currentWorkspaceId = stringPath(meResponse, ['data', 'currentWorkspace', 'id']);
  const primaryUserId = stringPath(meResponse, ['data', 'user', 'id']);
  const primaryIsSuperAdmin = booleanPath(meResponse, ['data', 'user', 'isSuperAdmin']);

  if (meResponse.ok && currentWorkspaceId && primaryUserId) {
    checks.push(pass(
      'auth.session.me',
      'Authenticated session resolves current user and workspace',
      'auth',
      {
        status: meResponse.status,
        userId: primaryUserId,
        currentWorkspaceId,
        isSuperAdmin: primaryIsSuperAdmin,
      },
      [`GET ${config.apiUrl}/api/auth/me with the login session cookie`]
    ));
  } else {
    checks.push(finding(
      'auth.session.me',
      'Authenticated session did not resolve current user and workspace',
      'auth',
      'high',
      { status: meResponse.status, body: meResponse.body },
      [`GET ${config.apiUrl}/api/auth/me with the login session cookie`]
    ));
  }

  checks.push(await checkUnauthenticatedRoutes(config));
  checks.push(await checkForgedSessionTokens(config, userAgent));
  checks.push(...await checkApiTokenLifecycle(config, client));
  checks.push(...await checkRoleBoundaries(config, client, currentWorkspaceId, primaryIsSuperAdmin, userAgent));
  checks.push(await checkDatabaseBackedSessionExpiry(config, client));

  return checks;
}

async function checkHealth(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  const response = await client.request('/health');
  if (response.ok) {
    return pass('runner.health', 'API health endpoint responded', 'runner', {
      status: response.status,
      body: response.body,
    }, [`GET ${config.apiUrl}/health`]);
  }

  return finding('runner.health', 'API health endpoint did not respond successfully', 'runner', 'critical', {
    status: response.status,
    body: response.body,
  }, [`GET ${config.apiUrl}/health`]);
}

async function checkCsrf(client: ProbeHttpClient): Promise<ProbeCheck> {
  try {
    const token = await client.getCsrfToken(true);
    return pass('auth.csrf.token', 'CSRF token endpoint returns a token', 'auth', {
      tokenLength: token.length,
    }, ['GET /api/csrf-token']);
  } catch (error) {
    return finding('auth.csrf.token', 'CSRF token endpoint failed', 'auth', 'high', {
      error: error instanceof Error ? error.message : String(error),
    }, ['GET /api/csrf-token']);
  }
}

function checkSessionCookie(config: ProbeConfig, cookie: CookieMetadata | undefined, id: string, title: string): ProbeCheck {
  if (!cookie) {
    return finding(id, title, 'auth', 'critical', { cookiePresent: false }, [
      `Authenticate to ${config.apiUrl}`,
      'Inspect Set-Cookie for session_id',
    ]);
  }

  const evidence = {
    cookieName: cookie.name,
    valueLength: cookie.value.length,
    valueShape: classifySessionId(cookie.value),
    attributes: cookie.attributes,
  };

  const failures: string[] = [];
  if (!isStrongSessionId(cookie.value)) failures.push('session_id is not a 64-character hex token');
  if (cookie.attributes.httponly !== true) failures.push('HttpOnly is missing');

  const sameSite = stringAttribute(cookie, 'samesite');
  if (sameSite?.toLowerCase() !== 'strict') failures.push('SameSite is not Strict');

  const maxAge = stringAttribute(cookie, 'max-age');
  if (maxAge && Number(maxAge) > 900) failures.push('Max-Age exceeds 15 minutes');

  if (config.apiUrl.startsWith('https://') && cookie.attributes.secure !== true) {
    failures.push('Secure is missing on HTTPS target');
  }

  if (failures.length === 0) {
    return pass(id, title, 'auth', evidence, [
      `Authenticate to ${config.apiUrl}`,
      'Inspect the session_id Set-Cookie header',
    ]);
  }

  return finding(id, title, 'auth', isStrongSessionId(cookie.value) ? 'medium' : 'high', {
    ...evidence,
    failures,
  }, [
    `Authenticate to ${config.apiUrl}`,
    'Inspect the session_id Set-Cookie header',
  ]);
}

async function checkUnauthenticatedRoutes(config: ProbeConfig): Promise<ProbeCheck> {
  const unauthenticated = new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`);
  const routes = ['/api/auth/me', '/api/documents', '/api/issues', '/api/team/grid'];
  const results: Array<{ route: string; status: number; body: unknown }> = [];

  for (const route of routes) {
    const response = await unauthenticated.request(route);
    results.push({ route, status: response.status, body: compactBody(response.body) });
  }

  const exposed = results.filter((result) => result.status < 400 || result.status === 404);
  if (exposed.length === 0) {
    return pass('auth.unauthenticated_routes', 'Representative protected API routes reject unauthenticated requests', 'auth', {
      results,
    }, routes.map((route) => `GET ${config.apiUrl}${route} without cookies or bearer token`));
  }

  return finding('auth.unauthenticated_routes', 'Protected API routes are reachable without authentication', 'auth', 'critical', {
    exposed,
    results,
  }, routes.map((route) => `GET ${config.apiUrl}${route} without cookies or bearer token`));
}

async function checkForgedSessionTokens(config: ProbeConfig, userAgent: string): Promise<ProbeCheck> {
  const values = [
    'short-token',
    '0'.repeat(64),
    '11111111-1111-4111-8111-111111111111',
  ];
  const results: Array<{ valueShape: string; status: number; body: unknown }> = [];

  for (const value of values) {
    const forged = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
    forged.cookies.set('session_id', value);
    const response = await forged.request('/api/auth/me');
    results.push({ valueShape: classifySessionId(value), status: response.status, body: compactBody(response.body) });
  }

  const accepted = results.filter((result) => result.status < 400);
  if (accepted.length === 0) {
    return pass('auth.session.forged_tokens', 'Forged session tokens are rejected', 'auth', { results }, [
      'Set session_id to short, all-zero hex, and UUID-like values',
      `GET ${config.apiUrl}/api/auth/me`,
    ]);
  }

  return finding('auth.session.forged_tokens', 'Forged session token was accepted', 'auth', 'critical', {
    accepted,
    results,
  }, [
    'Set session_id to short, all-zero hex, and UUID-like values',
    `GET ${config.apiUrl}/api/auth/me`,
  ]);
}

async function checkApiTokenLifecycle(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck[]> {
  if (!config.allowMutation) {
    return [notTested('auth.api_tokens.lifecycle', 'API token lifecycle requires --allow-mutation', 'auth', {
      allowMutation: false,
    })];
  }

  const checks: ProbeCheck[] = [];
  const tokenName = `${config.runId}-api-token`;
  const createResponse = await client.request('/api/api-tokens', {
    method: 'POST',
    csrf: true,
    body: { name: tokenName, expires_in_days: 1 },
  });

  const token = stringPath(createResponse, ['data', 'token']);
  const tokenId = stringPath(createResponse, ['data', 'id']);

  if (!createResponse.ok || !token || !tokenId) {
    checks.push(finding('auth.api_tokens.create', 'API token could not be created', 'auth', 'medium', {
      status: createResponse.status,
      body: createResponse.body,
    }, [
      `POST ${config.apiUrl}/api/api-tokens with a logged-in session`,
    ]));
    return checks;
  }

  checks.push(pass('auth.api_tokens.create', 'API token can be created for the logged-in user', 'auth', {
    status: createResponse.status,
    tokenId,
    tokenPrefix: token.slice(0, 12),
    tokenLength: token.length,
  }, [`POST ${config.apiUrl}/api/api-tokens with a logged-in session`]));

  const tokenClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`);
  const bearerResponse = await tokenClient.request('/api/auth/me', { bearerToken: token });
  if (bearerResponse.ok) {
    checks.push(pass('auth.api_tokens.bearer_access', 'API token authenticates without session cookies', 'auth', {
      status: bearerResponse.status,
    }, [`GET ${config.apiUrl}/api/auth/me with Authorization: Bearer <created token>`]));
  } else {
    checks.push(finding('auth.api_tokens.bearer_access', 'Created API token did not authenticate', 'auth', 'high', {
      status: bearerResponse.status,
      body: bearerResponse.body,
    }, [`GET ${config.apiUrl}/api/auth/me with Authorization: Bearer <created token>`]));
  }

  const revokeResponse = await client.request(`/api/api-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
    csrf: true,
  });
  if (revokeResponse.ok) {
    checks.push(pass('auth.api_tokens.revoke', 'API token can be revoked', 'auth', {
      status: revokeResponse.status,
      tokenId,
    }, [`DELETE ${config.apiUrl}/api/api-tokens/${tokenId}`]));
  } else {
    checks.push(finding('auth.api_tokens.revoke', 'API token cleanup/revocation failed', 'auth', 'high', {
      status: revokeResponse.status,
      body: revokeResponse.body,
      tokenId,
    }, [`DELETE ${config.apiUrl}/api/api-tokens/${tokenId}`]));
  }

  const revokedResponse = await tokenClient.request('/api/auth/me', { bearerToken: token });
  if (revokedResponse.status === 401) {
    checks.push(pass('auth.api_tokens.revoked_rejected', 'Revoked API token is rejected', 'auth', {
      status: revokedResponse.status,
    }, [`GET ${config.apiUrl}/api/auth/me with the revoked bearer token`]));
  } else {
    checks.push(finding('auth.api_tokens.revoked_rejected', 'Revoked API token was still accepted', 'auth', 'critical', {
      status: revokedResponse.status,
      body: revokedResponse.body,
    }, [`GET ${config.apiUrl}/api/auth/me with the revoked bearer token`]));
  }

  return checks;
}

async function checkRoleBoundaries(
  config: ProbeConfig,
  primaryClient: ProbeHttpClient,
  workspaceId: string | undefined,
  primaryIsSuperAdmin: boolean,
  userAgent: string
): Promise<ProbeCheck[]> {
  if (!config.allowMutation) {
    return [notTested('auth.roles.boundaries', 'Role-boundary probes require --allow-mutation', 'auth', {
      allowMutation: false,
    })];
  }

  if (!workspaceId) {
    return [notTested('auth.roles.boundaries', 'Role-boundary probes need a current workspace id', 'auth', {
      workspaceIdPresent: false,
    })];
  }

  const checks: ProbeCheck[] = [];
  const createdUsers: CreatedRoleUser[] = [];

  for (const role of ['member', 'admin'] as const) {
    const created = await createInvitedRoleUser(config, primaryClient, workspaceId, role, userAgent);
    if (!('user' in created)) {
      checks.push(created.check);
      continue;
    }
    createdUsers.push(created.user);
    checks.push(created.check);
    checks.push(checkSessionCookie(
      config,
      created.user.sessionCookie,
      `auth.roles.${role}.invite_session_cookie`,
      `Invite-accepted ${role} session cookie is hardened`
    ));
  }

  const member = createdUsers.find((user) => user.role === 'member');
  const admin = createdUsers.find((user) => user.role === 'admin');

  if (member) {
    const workspaceMembersResponse = await member.client.request(`/api/workspaces/${workspaceId}/members`);
    const adminRouteResponse = await member.client.request('/api/admin/workspaces');
    if (workspaceMembersResponse.status === 403 && adminRouteResponse.status === 403) {
      checks.push(pass('auth.roles.member_denied_admin_routes', 'Workspace member is denied workspace-admin and super-admin routes', 'auth', {
        workspaceMembersStatus: workspaceMembersResponse.status,
        adminWorkspacesStatus: adminRouteResponse.status,
      }, [
        `Login as generated member ${member.email}`,
        `GET ${config.apiUrl}/api/workspaces/${workspaceId}/members`,
        `GET ${config.apiUrl}/api/admin/workspaces`,
      ]));
    } else {
      checks.push(finding('auth.roles.member_denied_admin_routes', 'Workspace member reached admin-only route', 'auth', 'critical', {
        workspaceMembersStatus: workspaceMembersResponse.status,
        adminWorkspacesStatus: adminRouteResponse.status,
      }, [
        `Login as generated member ${member.email}`,
        `GET ${config.apiUrl}/api/workspaces/${workspaceId}/members`,
        `GET ${config.apiUrl}/api/admin/workspaces`,
      ]));
    }
  }

  if (admin) {
    const workspaceMembersResponse = await admin.client.request(`/api/workspaces/${workspaceId}/members`);
    const adminRouteResponse = await admin.client.request('/api/admin/workspaces');
    if (workspaceMembersResponse.ok && adminRouteResponse.status === 403) {
      checks.push(pass('auth.roles.workspace_admin_scope', 'Workspace admin can administer workspace but not super-admin routes', 'auth', {
        workspaceMembersStatus: workspaceMembersResponse.status,
        adminWorkspacesStatus: adminRouteResponse.status,
      }, [
        `Login as generated workspace admin ${admin.email}`,
        `GET ${config.apiUrl}/api/workspaces/${workspaceId}/members`,
        `GET ${config.apiUrl}/api/admin/workspaces`,
      ]));
    } else {
      checks.push(finding('auth.roles.workspace_admin_scope', 'Workspace admin role boundary failed', 'auth', 'critical', {
        workspaceMembersStatus: workspaceMembersResponse.status,
        adminWorkspacesStatus: adminRouteResponse.status,
      }, [
        `Login as generated workspace admin ${admin.email}`,
        `GET ${config.apiUrl}/api/workspaces/${workspaceId}/members`,
        `GET ${config.apiUrl}/api/admin/workspaces`,
      ]));
    }
  }

  const primaryAdminResponse = await primaryClient.request('/api/admin/workspaces');
  if (primaryIsSuperAdmin && primaryAdminResponse.ok) {
    checks.push(pass('auth.roles.super_admin_access', 'Super-admin user can access super-admin route', 'auth', {
      status: primaryAdminResponse.status,
    }, [`GET ${config.apiUrl}/api/admin/workspaces as ${config.email}`]));
  } else if (primaryIsSuperAdmin) {
    checks.push(finding('auth.roles.super_admin_access', 'Super-admin user could not access super-admin route', 'auth', 'medium', {
      status: primaryAdminResponse.status,
      body: primaryAdminResponse.body,
    }, [`GET ${config.apiUrl}/api/admin/workspaces as ${config.email}`]));
  } else {
    checks.push(notTested('auth.roles.super_admin_access', 'Configured user is not a super-admin, so super-admin route access was not expected', 'auth', {
      configuredEmail: config.email,
      isSuperAdmin: primaryIsSuperAdmin,
      routeStatus: primaryAdminResponse.status,
    }));
  }

  if (!config.keepData) {
    checks.push(...await cleanupRoleUsers(config, primaryClient, workspaceId, createdUsers));
  } else {
    checks.push(notTested('auth.roles.cleanup', 'Cleanup skipped because --keep-data was set', 'auth', {
      createdUsers: createdUsers.map((user) => ({ email: user.email, userId: user.userId, role: user.role })),
    }));
  }

  return checks;
}

async function createInvitedRoleUser(
  config: ProbeConfig,
  primaryClient: ProbeHttpClient,
  workspaceId: string,
  role: 'admin' | 'member',
  userAgent: string
): Promise<{ user: CreatedRoleUser; check: ProbeCheck } | { check: ProbeCheck }> {
  const email = `${config.runId}-${role}@probe.ship.local`.toLowerCase();
  const inviteResponse = await primaryClient.request(`/api/workspaces/${workspaceId}/invites`, {
    method: 'POST',
    csrf: true,
    body: { email, role },
  });
  const token = stringPath(inviteResponse, ['data', 'invite', 'token']);

  if (!inviteResponse.ok || !token) {
    return {
      check: finding(`auth.roles.${role}.invite`, `Could not create ${role} invite for role-boundary probe`, 'auth', 'medium', {
        status: inviteResponse.status,
        body: inviteResponse.body,
        email,
      }, [`POST ${config.apiUrl}/api/workspaces/${workspaceId}/invites with role=${role}`]),
    };
  }

  const invitedClient = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  await invitedClient.getCsrfToken(true);
  const acceptResponse = await invitedClient.request(`/api/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    csrf: true,
    body: { password: GENERATED_PASSWORD, name: `Probe ${role} ${config.runId}` },
  });
  const userId = stringPath(acceptResponse, ['data', 'user', 'id']);

  if (!acceptResponse.ok || !userId) {
    return {
      check: finding(`auth.roles.${role}.accept_invite`, `Could not accept ${role} invite for role-boundary probe`, 'auth', 'medium', {
        status: acceptResponse.status,
        body: acceptResponse.body,
        email,
      }, [`POST ${config.apiUrl}/api/invites/<redacted-token>/accept with generated ${role} credentials`]),
    };
  }

  return {
    user: {
      role,
      email,
      userId,
      client: invitedClient,
      sessionCookie: invitedClient.cookies.get('session_id'),
    },
    check: pass(`auth.roles.${role}.fixture`, `Generated ${role} user fixture was created`, 'auth', {
      email,
      userId,
      workspaceId,
    }, [
      `POST ${config.apiUrl}/api/workspaces/${workspaceId}/invites with role=${role}`,
      `POST ${config.apiUrl}/api/invites/<redacted-token>/accept with generated credentials`,
    ]),
  };
}

async function cleanupRoleUsers(
  config: ProbeConfig,
  primaryClient: ProbeHttpClient,
  workspaceId: string,
  createdUsers: CreatedRoleUser[]
): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  for (const user of createdUsers) {
    const response = await primaryClient.request(`/api/workspaces/${workspaceId}/members/${encodeURIComponent(user.userId)}`, {
      method: 'DELETE',
      csrf: true,
    });

    if (response.ok || response.status === 404) {
      checks.push(pass(`auth.roles.${user.role}.cleanup`, `Generated ${user.role} membership was cleaned up`, 'auth', {
        email: user.email,
        userId: user.userId,
        status: response.status,
        note: 'The app removes workspace membership and archives the person document; global user identity is retained by the application.',
      }, [`DELETE ${config.apiUrl}/api/workspaces/${workspaceId}/members/${user.userId}`]));
    } else {
      checks.push(finding(`auth.roles.${user.role}.cleanup`, `Generated ${user.role} membership cleanup failed`, 'auth', 'medium', {
        email: user.email,
        userId: user.userId,
        status: response.status,
        body: response.body,
      }, [`DELETE ${config.apiUrl}/api/workspaces/${workspaceId}/members/${user.userId}`]));
    }
  }
  return checks;
}

async function checkDatabaseBackedSessionExpiry(config: ProbeConfig, client: ProbeHttpClient): Promise<ProbeCheck> {
  if (!config.allowMutation) {
    return notTested('auth.session.expiry_db', 'Session expiry proof requires --allow-mutation', 'auth', {
      allowMutation: false,
    });
  }

  if (!config.databaseUrl) {
    return notTested('auth.session.expiry_db', 'Session expiry proof requires DATABASE_URL', 'auth', {
      databaseUrlAvailable: false,
    });
  }

  const sessionCookie = client.cookies.get('session_id');
  if (!sessionCookie) {
    return notTested('auth.session.expiry_db', 'Session expiry proof requires an active session cookie', 'auth', {
      sessionCookiePresent: false,
    });
  }

  const pgPool = await createPgPool(config.databaseUrl);
  if (!pgPool) {
    return notTested('auth.session.expiry_db', 'pg package is not available to the probe runtime', 'auth', {
      databaseUrlAvailable: true,
      hint: 'Run pnpm install after adding the probe workspace if this check is required.',
    });
  }

  try {
    await pgPool.query(
      `UPDATE sessions
       SET last_activity = NOW() - INTERVAL '20 minutes',
           expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [sessionCookie.value]
    );
  } catch (error) {
    await pgPool.end();
    return finding('auth.session.expiry_db', 'Failed to backdate the active session in the database', 'auth', 'medium', {
      error: error instanceof Error ? error.message : String(error),
    }, [
      'Set DATABASE_URL for the target database',
      `UPDATE sessions SET last_activity = old timestamp WHERE id = ${sessionCookie.value}`,
    ]);
  }

  await pgPool.end();

  const expiredResponse = await client.request('/api/auth/me');
  if (expiredResponse.status === 401) {
    return pass('auth.session.expiry_db', 'Backdated session is rejected as expired', 'auth', {
      status: expiredResponse.status,
    }, [
      'Backdate the active row in sessions.last_activity and sessions.expires_at',
      `GET ${config.apiUrl}/api/auth/me with the backdated session cookie`,
    ]);
  }

  return finding('auth.session.expiry_db', 'Backdated session was still accepted', 'auth', 'high', {
    status: expiredResponse.status,
    body: expiredResponse.body,
  }, [
    'Backdate the active row in sessions.last_activity and sessions.expires_at',
    `GET ${config.apiUrl}/api/auth/me with the backdated session cookie`,
  ]);
}

function authNotTestedAfterLoginFailure(): ProbeCheck[] {
  return [
    notTested('auth.session.cookie_login', 'Login session cookie checks require successful login', 'auth', {}),
    notTested('auth.session.me', 'Authenticated session checks require successful login', 'auth', {}),
    notTested('auth.api_tokens.lifecycle', 'API token lifecycle checks require successful login', 'auth', {}),
    notTested('auth.roles.boundaries', 'Role-boundary checks require successful login', 'auth', {}),
    notTested('auth.session.expiry_db', 'Session expiry checks require successful login', 'auth', {}),
  ];
}

function isStrongSessionId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function classifySessionId(value: string): string {
  if (/^[a-f0-9]{64}$/.test(value)) return '64-char-lower-hex';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return 'uuid';
  return `other-${value.length}-chars`;
}

function stringAttribute(cookie: CookieMetadata, name: string): string | undefined {
  const value = cookie.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function stringPath(response: { body: unknown }, path: string[]): string | undefined {
  const value = responseBodyPath(response as never, path);
  return typeof value === 'string' ? value : undefined;
}

function booleanPath(response: { body: unknown }, path: string[]): boolean {
  const value = responseBodyPath(response as never, path);
  return typeof value === 'boolean' ? value : false;
}

function compactBody(body: unknown): unknown {
  if (typeof body === 'string') return body.slice(0, 300);
  return body;
}

type PgPool = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
};

async function createPgPool(databaseUrl: string): Promise<PgPool | null> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const imported = await dynamicImport('pg');
    const moduleRecord = imported as {
      Pool?: new (config: { connectionString: string }) => PgPool;
      default?: { Pool?: new (config: { connectionString: string }) => PgPool };
    };
    const Pool = moduleRecord.Pool ?? moduleRecord.default?.Pool;
    return Pool ? new Pool({ connectionString: databaseUrl }) : null;
  } catch {
    return null;
  }
}
