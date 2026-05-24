export type CookieMetadata = {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
  raw: string;
};

export type ProbeResponse<T = unknown> = {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bodyText: string;
  body: T | string | null;
  setCookies: CookieMetadata[];
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
  bearerToken?: string;
  timeoutMs?: number;
};

export class CookieJar {
  private readonly cookies = new Map<string, CookieMetadata>();

  set(name: string, value: string, attributes: Record<string, string | true> = {}): void {
    this.cookies.set(name, {
      name,
      value,
      attributes,
      raw: `${name}=${value}`,
    });
  }

  setFromHeader(header: string): CookieMetadata | null {
    const parsed = parseSetCookie(header);
    if (!parsed) return null;
    this.cookies.set(parsed.name, parsed);
    return parsed;
  }

  get(name: string): CookieMetadata | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
}

export class ProbeHttpClient {
  readonly cookies = new CookieJar();
  private csrfToken?: string;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs: number,
    private readonly userAgent: string
  ) {}

  async getCsrfToken(force = false): Promise<string> {
    if (this.csrfToken && !force) return this.csrfToken;

    const response = await this.request<{ token?: string }>('/api/csrf-token', {
      method: 'GET',
      csrf: false,
    });
    const token = typeof response.body === 'object' && response.body !== null ? response.body.token : undefined;

    if (!response.ok || typeof token !== 'string' || token.length === 0) {
      throw new Error(`GET /api/csrf-token failed with ${response.status}`);
    }

    this.csrfToken = token;
    return token;
  }

  async login(email: string, password: string): Promise<ProbeResponse> {
    try {
      await this.getCsrfToken(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        url: `${this.baseUrl}/api/auth/login`,
        status: 0,
        ok: false,
        headers: {},
        bodyText: message,
        body: { error: message },
        setCookies: [],
      };
    }

    return this.request('/api/auth/login', {
      method: 'POST',
      csrf: true,
      body: { email, password },
    });
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ProbeResponse<T>> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...options.headers,
    };

    const cookieHeader = this.cookies.header();
    if (cookieHeader) headers.cookie = cookieHeader;
    if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;
    if (options.csrf) headers['x-csrf-token'] = await this.getCsrfToken();

    let requestBody: BodyInit | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        url,
        status: 0,
        ok: false,
        headers: {},
        bodyText: message,
        body: message,
        setCookies: [],
      };
    }

    const setCookieHeaders = getSetCookieHeaders(response.headers);
    const setCookies: CookieMetadata[] = [];
    for (const header of setCookieHeaders) {
      const parsed = this.cookies.setFromHeader(header);
      if (parsed) setCookies.push(parsed);
    }

    const bodyText = await response.text();
    const body = parseBody(bodyText, response.headers.get('content-type') ?? '');

    return {
      url,
      status: response.status,
      ok: response.ok,
      headers: headersToRecord(response.headers),
      bodyText,
      body: body as T | string | null,
      setCookies,
    };
  }
}

export function responseBodyPath(response: ProbeResponse, path: string[]): unknown {
  let cursor: unknown = response.body;
  for (const part of path) {
    if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function parseSetCookie(header: string): CookieMetadata | null {
  const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
  const first = parts[0];
  if (!first) return null;

  const separatorIndex = first.indexOf('=');
  if (separatorIndex <= 0) return null;

  const name = first.slice(0, separatorIndex);
  const value = first.slice(separatorIndex + 1);
  const attributes: Record<string, string | true> = {};

  for (const attribute of parts.slice(1)) {
    const attributeSeparator = attribute.indexOf('=');
    if (attributeSeparator === -1) {
      attributes[attribute.toLowerCase()] = true;
    } else {
      attributes[attribute.slice(0, attributeSeparator).toLowerCase()] = attribute.slice(attributeSeparator + 1);
    }
  }

  return { name, value, attributes, raw: header };
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getter = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') {
    return getter.call(headers);
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function parseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (!contentType.includes('application/json')) return text;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
