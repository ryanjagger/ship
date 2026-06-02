/**
 * ScopeRegistry — scopes as data, not a switch statement (PRD §5.4, §5.6).
 *
 * `documents:read` is the BROADEST read scope: "read all document content"
 * across every user-facing `document_type`. It sits intentionally and strictly
 * ABOVE the future per-type read scopes (`wiki:read`, `issues:read`,
 * `sprints:read`) — the privilege hierarchy is by design, not accident, so it
 * is answerable in the interview. The narrower typed scopes are additive
 * convenience surfaces that ship later; `documents:read` never narrows.
 *
 * Only `documents:*` is exercised by a live route at the gate. The rest are
 * registered now so app registration can validate against the full known set
 * and so later phases slot in without reshaping this surface.
 */
export interface ScopeDefinition {
  scope: string;
  description: string;
  /** True when a live route enforces this scope at the gate. */
  exercised: boolean;
}

const SCOPES: ScopeDefinition[] = [
  {
    scope: 'documents:read',
    description:
      'Read all document content. Broadest read scope — superset of wiki:read / issues:read / sprints:read.',
    exercised: true,
  },
  { scope: 'documents:write', description: 'Create and update documents.', exercised: true },

  // Registered for forward-compatibility; not enforced by any route at the gate.
  { scope: 'issues:read', description: 'Read issues (narrower than documents:read).', exercised: false },
  { scope: 'issues:write', description: 'Create and update issues.', exercised: false },
  { scope: 'sprints:read', description: 'Read sprints (narrower than documents:read).', exercised: false },
  { scope: 'sprints:write', description: 'Create and update sprints.', exercised: false },
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
