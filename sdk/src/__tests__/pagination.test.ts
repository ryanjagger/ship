import { describe, it, expect } from 'vitest';
import { ShipClient } from '../index.js';

/**
 * A fetch stub that serves cursor-paginated pages keyed by the `cursor` query
 * param, and records every request URL so we can assert laziness + filter
 * preservation.
 */
function paginatingFetch(pages: Array<{ data: unknown[]; next_cursor: string | null }>) {
  const urls: string[] = [];
  let pageIndex = 0;
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const cursor = new URL(url).searchParams.get('cursor');
    // First request has no cursor; subsequent ones use the prior next_cursor.
    const idx = cursor == null ? 0 : Number(cursor);
    pageIndex = idx;
    const page = pages[idx] ?? { data: [], next_cursor: null };
    return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl, get pageIndex() { return pageIndex; } };
}

function client(fetchImpl: typeof fetch) {
  return new ShipClient({ token: 'ship_at_test', baseUrl: 'https://api.test', fetch: fetchImpl });
}

describe('async-iterator pagination', () => {
  it('yields nothing for an empty single page', async () => {
    const { urls, fetchImpl } = paginatingFetch([{ data: [], next_cursor: null }]);
    const seen: unknown[] = [];
    for await (const item of client(fetchImpl).issues.iterate()) seen.push(item);
    expect(seen).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('yields one page then stops when next_cursor is null', async () => {
    const { urls, fetchImpl } = paginatingFetch([{ data: [{ id: 'a' }, { id: 'b' }], next_cursor: null }]);
    const seen: Array<{ id: string }> = [];
    for await (const item of client(fetchImpl).issues.iterate()) seen.push(item as { id: string });
    expect(seen.map((x) => x.id)).toEqual(['a', 'b']);
    expect(urls).toHaveLength(1);
  });

  it('walks multiple pages following next_cursor', async () => {
    const { urls, fetchImpl } = paginatingFetch([
      { data: [{ id: 'a' }], next_cursor: '1' },
      { data: [{ id: 'b' }], next_cursor: '2' },
      { data: [{ id: 'c' }], next_cursor: null },
    ]);
    const seen: string[] = [];
    for await (const item of client(fetchImpl).issues.iterate()) seen.push((item as { id: string }).id);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('1');
    expect(new URL(urls[2]!).searchParams.get('cursor')).toBe('2');
  });

  it('is lazy: stops fetching after an early break', async () => {
    const { urls, fetchImpl } = paginatingFetch([
      { data: [{ id: 'a' }], next_cursor: '1' },
      { data: [{ id: 'b' }], next_cursor: '2' },
      { data: [{ id: 'c' }], next_cursor: null },
    ]);
    for await (const item of client(fetchImpl).issues.iterate()) {
      if ((item as { id: string }).id === 'a') break;
    }
    // Only the first page should have been fetched.
    expect(urls).toHaveLength(1);
  });

  it('preserves caller filters across pages (documents.type)', async () => {
    const { urls, fetchImpl } = paginatingFetch([
      { data: [{ id: 'a' }], next_cursor: '1' },
      { data: [{ id: 'b' }], next_cursor: null },
    ]);
    const seen: string[] = [];
    for await (const doc of client(fetchImpl).documents.iterate({ type: 'issue', limit: 50 })) {
      seen.push((doc as { id: string }).id);
    }
    expect(seen).toEqual(['a', 'b']);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('type')).toBe('issue');
      expect(params.get('limit')).toBe('50');
    }
  });
});
