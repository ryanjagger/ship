/**
 * Opaque keyset cursor for the documents list (PRD §5.5). Encodes the stable,
 * cross-type sort key (`created_at` + `id`) — never a per-type field — so the
 * mixed-type list paginates deterministically. base64url of a small JSON blob;
 * full cursor semantics are post-MVP, but the stable sort matters now.
 */
export interface Cursor {
  created_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const { created_at, id } = parsed as Record<string, unknown>;
      if (typeof created_at === 'string' && typeof id === 'string') {
        return { created_at, id };
      }
    }
    return null;
  } catch {
    return null;
  }
}
