/**
 * Typed-resource manifest (PRD §1, §4). The single source of truth for the
 * typed resources `/api/v1/issues`, `/sprints`, `/wiki` — consumed by BOTH the
 * router (which mounts them) and the OpenAPI generator (which documents them),
 * so a new typed resource can never drift between the runtime and the spec.
 *
 * This is declarative configuration, not a route handler, so it lives at the v1
 * root rather than under `routes/` — the OpenAPI generator can read it without
 * importing the handler layer.
 */
export interface TypedResource {
  /** URL segment under /api/v1 (e.g. "issues"). */
  path: string;
  /** The pinned document_type (e.g. "issue"). */
  documentType: string;
  readScope: string;
  writeScope: string;
  /** OpenAPI tag. */
  tag: string;
  /** Title-cased singular, e.g. "Issue", used in "Issue not found". */
  label: string;
}

export const TYPED_RESOURCES: TypedResource[] = [
  { path: 'issues', documentType: 'issue', readScope: 'issues:read', writeScope: 'issues:write', tag: 'issues', label: 'Issue' },
  { path: 'sprints', documentType: 'sprint', readScope: 'sprints:read', writeScope: 'sprints:write', tag: 'sprints', label: 'Sprint' },
  { path: 'wiki', documentType: 'wiki', readScope: 'wiki:read', writeScope: 'wiki:write', tag: 'wiki', label: 'Wiki page' },
];
