import type { Router as RouterType } from 'express';
import { createDocumentResourceRouter } from './document-resource.js';
import type { TypedResource } from '../resources.js';

/**
 * Router factory for a typed resource (PRD §1, §4) — `/api/v1/issues`,
 * `/sprints`, `/wiki`. Each is the `documents` engine pinned to one
 * `document_type` and gated by the narrower `{type}:read|write` scopes. Because
 * `documents:read` IMPLIES `{type}:read` (see scopes/registry.ts), a
 * `documents:*` token reaches these too — the privilege hierarchy is enforced
 * live, not just declared.
 *
 * The resource manifest itself lives in `../resources.ts` so the OpenAPI
 * generator can read it without importing this handler module.
 */
export function createTypedResourceRouter(resource: TypedResource): RouterType {
  return createDocumentResourceRouter({
    pinnedType: resource.documentType,
    readScope: resource.readScope,
    writeScope: resource.writeScope,
    notFoundLabel: `${resource.label} not found`,
  });
}
