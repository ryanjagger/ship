/**
 * Programmatic device-code approval — stands in for the human who would normally
 * open the verification URL and click "Approve".
 *
 * Mirrors the session flow the dev portal / smoke-test use:
 *   1. GET  /api/csrf-token         → double-submit token (+ csrf cookie)
 *   2. POST /api/auth/login         → session cookie (dev@ship.local / admin123)
 *   3. POST /api/oauth/device/decision { user_code, decision: 'approve' }
 *      binding the eventual token to this user + their current workspace.
 *
 * The login happens once; `approve(userCode)` is wired as deviceLogin's
 * `onUserCode` callback so the device flow completes unattended.
 */

export interface AdminCreds {
  email: string;
  password: string;
}

export interface Approver {
  approve(userCode: string): Promise<void>;
}

/** Minimal in-memory cookie jar (name=value), good enough for one session. */
class CookieJar {
  private jar = new Map<string, string>();

  capture(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const pair = sc.split(';', 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

export async function createApprover(apiUrl: string, creds: AdminCreds): Promise<Approver> {
  const base = apiUrl.replace(/\/$/, '');
  const jar = new CookieJar();

  async function csrfToken(): Promise<string> {
    const res = await fetch(`${base}/api/csrf-token`, { headers: { cookie: jar.header() } });
    jar.capture(res);
    if (!res.ok) throw new Error(`csrf-token failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('csrf-token response missing token');
    return body.token;
  }

  // Log in once to establish the session cookie.
  const loginCsrf = await csrfToken();
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': loginCsrf,
      cookie: jar.header(),
    },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  jar.capture(loginRes);
  if (!loginRes.ok) {
    throw new Error(`login as ${creds.email} failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  return {
    async approve(userCode: string): Promise<void> {
      const token = await csrfToken();
      const res = await fetch(`${base}/api/oauth/device/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
          cookie: jar.header(),
        },
        body: JSON.stringify({ user_code: userCode, decision: 'approve' }),
      });
      jar.capture(res);
      if (!res.ok) {
        throw new Error(`device approval failed for ${userCode}: ${res.status} ${await res.text()}`);
      }
    },
  };
}
