import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { createApp } from '../../../../../app.js';
import { TYPED_DOCUMENT_RESOURCES } from '../../schemas/typed-document.js';
import { generateV1OpenApiDocument } from '../spec.js';

/**
 * OpenAPI 3.1 spec fitness (PRD §5.7, gate item 7): the generated spec must
 * validate against the OpenAPI 3.1 JSON schema, be served at
 * /api/v1/openapi.json, and stay in sync with the committed static copy.
 */
describe('Platform API · OpenAPI 3.1 spec', () => {
  it('validates against the OpenAPI 3.1 schema', async () => {
    const doc = generateV1OpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');

    const validator = new Validator();
    const result = await validator.validate(doc as unknown as Record<string, unknown>);
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toBeUndefined();
    expect(result.valid).toBe(true);
    // The validator detects the version from the document itself.
    expect(validator.version).toBe('3.1');
  });

  it('declares the public surface (paths, schemas, bearer security)', () => {
    const doc = generateV1OpenApiDocument() as unknown as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    const typedPaths = TYPED_DOCUMENT_RESOURCES.flatMap((resource) => [
      `/${resource.path}`,
      `/${resource.path}/{id}`,
    ]);
    expect(Object.keys(doc.paths).sort()).toEqual(['/documents', '/documents/{id}', '/me', ...typedPaths].sort());
    expect(doc.paths['/documents']).toHaveProperty('get');
    expect(doc.paths['/documents']).toHaveProperty('post');
    expect(doc.paths['/issues']).toHaveProperty('get');
    expect(doc.paths['/issues']).toHaveProperty('post');
    expect(doc.paths['/issues/{id}']).toHaveProperty('patch');
    expect(doc.paths['/issues/{id}']).toHaveProperty('delete');
    expect(doc.components.schemas).toHaveProperty('ApiError');
    expect(doc.components.schemas).toHaveProperty('Issue');
    expect(doc.components.schemas).toHaveProperty('Sprint');
    expect(doc.components.schemas).toHaveProperty('WikiPage');
    expect(doc.components.schemas).toHaveProperty('CreateIssue');
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('is served (public, no auth) at GET /api/v1/openapi.json', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('matches the committed static copy at docs/openapi.json (run pnpm openapi:export after spec changes)', () => {
    // vitest runs with cwd = api package root.
    const staticPath = join(process.cwd(), '..', 'docs', 'openapi.json');
    const committed = JSON.parse(readFileSync(staticPath, 'utf-8'));
    expect(committed).toEqual(generateV1OpenApiDocument());
  });
});
