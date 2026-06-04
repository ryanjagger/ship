import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATION_MANIFEST, operationKey } from '../manifest.js';

/**
 * Contract drift gate (PRD §1, success metric "OpenAPI to SDK drift = 0").
 * Walks every operation in the committed Platform API spec and asserts the SDK
 * operation manifest covers it (or marks it intentionally unsupported). When a
 * new endpoint is added to `/api/v1` and the spec is regenerated, this fails
 * until the SDK manifest (and a method) is added too.
 */

const here = dirname(fileURLToPath(import.meta.url));
// sdk/src/__tests__ → repo root is 3 levels up.
const specPath = join(here, '..', '..', '..', 'docs', 'openapi.json');

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function loadOperations(): string[] {
  const doc = JSON.parse(readFileSync(specPath, 'utf-8')) as OpenApiDoc;
  const ops: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        ops.push(operationKey(method, path));
      }
    }
  }
  return ops;
}

describe('OpenAPI → SDK contract', () => {
  it('committed docs/openapi.json is loadable and non-empty', () => {
    const ops = loadOperations();
    expect(ops.length).toBeGreaterThan(0);
  });

  it('every public operation maps to an SDK method in the manifest', () => {
    const ops = loadOperations();
    const missing = ops.filter((key) => !(key in OPERATION_MANIFEST));
    expect(
      missing,
      `These OpenAPI operations have no SDK manifest entry. Add them to sdk/src/manifest.ts ` +
        `(and a corresponding SDK method), or mark them unsupported:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('manifest has no stale entries that are absent from the spec', () => {
    const ops = new Set(loadOperations());
    const stale = Object.keys(OPERATION_MANIFEST).filter((key) => !ops.has(key));
    expect(
      stale,
      `These manifest entries no longer exist in docs/openapi.json (remove them):\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });
});
