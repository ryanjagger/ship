import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryTokenStore,
  FileTokenStore,
  LocalStorageTokenStore,
  coerceTokenSet,
  type ShipTokenSet,
  type WebStorageLike,
} from '../auth/token-store.js';

const sample: ShipTokenSet = { accessToken: 'ship_at_abc', tokenType: 'Bearer', scope: 'documents:read', expiresAt: 123 };

function fakeStorage(): WebStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe.each([
  ['MemoryTokenStore', () => new MemoryTokenStore()],
  ['LocalStorageTokenStore', () => new LocalStorageTokenStore({ storage: fakeStorage() })],
])('%s read/write/clear', (_name, make) => {
  it('round-trips and clears', async () => {
    const store = make();
    expect(await store.get()).toBeNull();
    await store.set(sample);
    expect(await store.get()).toEqual(sample);
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

describe('FileTokenStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ship-tok-'));
  });

  it('round-trips, clears, and tolerates a missing file', async () => {
    const store = new FileTokenStore(join(dir, 'token.json'));
    expect(await store.get()).toBeNull();
    await store.set(sample);
    expect(await store.get()).toEqual(sample);
    await store.clear();
    expect(await store.get()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('invalid persisted data', () => {
  it('LocalStorage returns null on corrupt JSON', async () => {
    const storage = fakeStorage();
    storage.setItem('ship.tokens', '{not json');
    expect(await new LocalStorageTokenStore({ storage }).get()).toBeNull();
  });

  it('coerceTokenSet rejects shapes without a string accessToken', () => {
    expect(coerceTokenSet(null)).toBeNull();
    expect(coerceTokenSet({})).toBeNull();
    expect(coerceTokenSet({ accessToken: 42 })).toBeNull();
    expect(coerceTokenSet({ accessToken: 'x', expiresAt: 'soon' })).toEqual({ accessToken: 'x', tokenType: undefined, scope: undefined, expiresAt: undefined });
  });
});
