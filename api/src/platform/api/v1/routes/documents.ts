import type { Router as RouterType } from 'express';
import { createDocumentResourceRouter } from './document-resource.js';

/**
 * Public `documents` resource (PRD §5.5) — the SUPERSET resource. It returns ANY
 * user-facing document_type (backing-store types excluded), and `documents:read`
 * is the broadest read scope; writes need `documents:write`. The typed resources
 * (`/issues`, `/sprints`, `/wiki`) are the same engine pinned to one type — see
 * `document-resource.ts` and `typed.ts`.
 */
export const documentsRouter: RouterType = createDocumentResourceRouter({
  pinnedType: null,
  readScope: 'documents:read',
  writeScope: 'documents:write',
  notFoundLabel: 'Document not found',
});
