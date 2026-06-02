/**
 * Writes the generated Platform API OpenAPI 3.1 spec to a static file at
 * docs/openapi.json (PRD §5.7 — "Commit a static copy"). Regenerate with:
 *   pnpm --filter @ship/api openapi:export
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateV1OpenApiDocument } from './spec.js';

const here = dirname(fileURLToPath(import.meta.url));
// repo root is 6 levels up: openapi → v1 → api → platform → src → api → <root>
const repoRoot = join(here, '..', '..', '..', '..', '..', '..');
const outPath = join(repoRoot, 'docs', 'openapi.json');

writeFileSync(outPath, JSON.stringify(generateV1OpenApiDocument(), null, 2) + '\n', 'utf-8');
console.log(`Wrote Platform API OpenAPI 3.1 spec to ${outPath}`);
