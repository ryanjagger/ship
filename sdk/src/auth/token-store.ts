/**
 * Token stores (PRD §2). A `ShipClient` produced by `deviceLogin` /
 * `authorizationCodeFlow` persists its token set through an `ITokenStore` so
 * subsequent runs reuse it. Stores NEVER log raw tokens.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A persisted OAuth token set. Ship issues short-lived access tokens (no refresh). */
export interface ShipTokenSet {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  /** Epoch milliseconds at which the access token expires, if known. */
  expiresAt?: number;
}

export interface ITokenStore {
  get(): Promise<ShipTokenSet | null>;
  set(tokens: ShipTokenSet): Promise<void>;
  clear(): Promise<void>;
}

/** Narrow + validate a parsed value into a `ShipTokenSet` (or null if invalid). */
export function coerceTokenSet(value: unknown): ShipTokenSet | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.accessToken !== 'string' || v.accessToken.length === 0) return null;
  return {
    accessToken: v.accessToken,
    tokenType: typeof v.tokenType === 'string' ? v.tokenType : undefined,
    scope: typeof v.scope === 'string' ? v.scope : undefined,
    expiresAt: typeof v.expiresAt === 'number' ? v.expiresAt : undefined,
  };
}

/** In-memory store; the default when no persistence is requested. */
export class MemoryTokenStore implements ITokenStore {
  private tokens: ShipTokenSet | null = null;

  async get(): Promise<ShipTokenSet | null> {
    return this.tokens;
  }
  async set(tokens: ShipTokenSet): Promise<void> {
    this.tokens = tokens;
  }
  async clear(): Promise<void> {
    this.tokens = null;
  }
}

/**
 * File-backed store for CLI/dev tools. Defaults to `~/.ship/token.json`, written
 * 0600 (owner-only) since it holds a bearer credential. Invalid/corrupt files
 * read back as `null` rather than throwing.
 */
export class FileTokenStore implements ITokenStore {
  private readonly path: string;

  constructor(filePath?: string) {
    this.path = filePath ?? join(homedir(), '.ship', 'token.json');
  }

  async get(): Promise<ShipTokenSet | null> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      return coerceTokenSet(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async set(tokens: ShipTokenSet): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch {
      /* already absent */
    }
  }
}

/** Minimal `localStorage`-shaped surface so we don't depend on DOM lib types. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Browser store backed by `localStorage` (or any `WebStorageLike`). Pass an
 * explicit storage in non-DOM environments/tests; otherwise it resolves
 * `globalThis.localStorage`.
 */
export class LocalStorageTokenStore implements ITokenStore {
  private readonly storage: WebStorageLike;
  private readonly key: string;

  constructor(options: { storage?: WebStorageLike; key?: string } = {}) {
    const storage = options.storage ?? (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (!storage) throw new Error('LocalStorageTokenStore requires localStorage or an explicit storage option');
    this.storage = storage;
    this.key = options.key ?? 'ship.tokens';
  }

  async get(): Promise<ShipTokenSet | null> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      return coerceTokenSet(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async set(tokens: ShipTokenSet): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}
