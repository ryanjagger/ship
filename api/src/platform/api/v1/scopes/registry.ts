/**
 * ScopeRegistry — scopes as data, not a switch statement (PRD §5.4, §5.6).
 *
 * `documents:read` is the BROADEST read scope: "read all document content"
 * across every user-facing `document_type`. It sits intentionally and strictly
 * ABOVE the per-type read scopes (`wiki:read`, `issues:read`, `sprints:read`):
 * a token holding `documents:read` SATISFIES `issues:read` without literally
 * being granted it (see `implies` + `satisfies`). The privilege hierarchy is by
 * design, not accident, so it is answerable in the interview; `documents:read`
 * never narrows.
 *
 * `documents:*` and the typed `{wiki,issues,sprints}:*` scopes are each
 * exercised by a live route. `webhooks:manage` is registered now (so app
 * registration validates against the full known set) but no route enforces it
 * yet — later phases slot in without reshaping this surface.
 */
export interface ScopeDefinition {
  scope: string;
  description: string;
  /** True when a live route enforces this scope. */
  exercised: boolean;
  /**
   * Scopes this one additionally grants — the privilege hierarchy made data.
   * A token holding `documents:read` satisfies `issues:read` without being
   * granted it literally, so the broad scope stays strictly above the narrow
   * typed ones. Single-level (direct) implication is sufficient: each superset
   * scope names every narrower scope it covers.
   */
  implies?: string[];
}

const SCOPES: ScopeDefinition[] = [
  {
    scope: 'documents:read',
    description:
      'Read all document content. Broadest read scope — superset of wiki:read / issues:read / sprints:read.',
    exercised: true,
    implies: ['wiki:read', 'issues:read', 'sprints:read'],
  },
  {
    scope: 'documents:write',
    description: 'Create and update documents of any type. Superset of wiki:write / issues:write / sprints:write.',
    exercised: true,
    implies: ['wiki:write', 'issues:write', 'sprints:write'],
  },

  // Typed resources (/api/v1/{wiki,issues,sprints}). Narrower than documents:*,
  // and reachable by a documents:* token via the implication above.
  { scope: 'wiki:read', description: 'Read wiki pages.', exercised: true },
  { scope: 'wiki:write', description: 'Create and update wiki pages.', exercised: true },
  { scope: 'issues:read', description: 'Read issues (narrower than documents:read).', exercised: true },
  { scope: 'issues:write', description: 'Create and update issues.', exercised: true },
  { scope: 'sprints:read', description: 'Read sprints (narrower than documents:read).', exercised: true },
  { scope: 'sprints:write', description: 'Create and update sprints.', exercised: true },

  // Registered for forward-compatibility; not enforced by any route yet.
  { scope: 'webhooks:manage', description: 'Manage webhook subscriptions.', exercised: false },
];

export class ScopeRegistry {
  private readonly byName: Map<string, ScopeDefinition>;

  constructor(defs: ScopeDefinition[]) {
    this.byName = new Map(defs.map((d) => [d.scope, d]));
  }

  has(scope: string): boolean {
    return this.byName.has(scope);
  }

  get(scope: string): ScopeDefinition | undefined {
    return this.byName.get(scope);
  }

  list(): ScopeDefinition[] {
    return [...this.byName.values()];
  }

  /**
   * Does any of `granted` satisfy `required` — directly, or because a granted
   * scope `implies` it? This is the authorization check `requireScope` runs, so
   * a `documents:read` token clears an `issues:read` gate while an `issues:read`
   * token does NOT clear a `documents:read` gate (the hierarchy is one-way).
   */
  satisfies(granted: readonly string[], required: string): boolean {
    for (const g of granted) {
      if (g === required) return true;
      if (this.byName.get(g)?.implies?.includes(required)) return true;
    }
    return false;
  }

  /** Partition requested scopes into known vs unknown (for registration validation). */
  partition(scopes: string[]): { known: string[]; unknown: string[] } {
    const known: string[] = [];
    const unknown: string[] = [];
    for (const s of scopes) {
      (this.byName.has(s) ? known : unknown).push(s);
    }
    return { known, unknown };
  }
}

export const scopeRegistry = new ScopeRegistry(SCOPES);
