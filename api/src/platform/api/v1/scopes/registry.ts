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
  { scope: 'issues:read', description: 'Read issues (narrower than documents:read).', exercised: true },
  { scope: 'issues:write', description: 'Create, update, and delete issues.', exercised: true },
  { scope: 'sprints:read', description: 'Read sprints (narrower than documents:read).', exercised: true },
  { scope: 'sprints:write', description: 'Create, update, and delete sprints.', exercised: true },
  { scope: 'wiki:read', description: 'Read wiki pages.', exercised: true },
  { scope: 'wiki:write', description: 'Create, update, and delete wiki pages.', exercised: true },
  { scope: 'programs:read', description: 'Read programs.', exercised: true },
  { scope: 'programs:write', description: 'Create, update, and delete programs.', exercised: true },
  { scope: 'projects:read', description: 'Read projects.', exercised: true },
  { scope: 'projects:write', description: 'Create, update, and delete projects.', exercised: true },
  { scope: 'people:read', description: 'Read people directory entries.', exercised: true },
  { scope: 'people:write', description: 'Create, update, and delete people directory entries.', exercised: true },
  { scope: 'weekly_plans:read', description: 'Read weekly plans.', exercised: true },
  { scope: 'weekly_plans:write', description: 'Create, update, and delete weekly plans.', exercised: true },
  { scope: 'weekly_retros:read', description: 'Read weekly retros.', exercised: true },
  { scope: 'weekly_retros:write', description: 'Create, update, and delete weekly retros.', exercised: true },
  { scope: 'standups:read', description: 'Read standups.', exercised: true },
  { scope: 'standups:write', description: 'Create, update, and delete standups.', exercised: true },
  { scope: 'weekly_reviews:read', description: 'Read weekly reviews.', exercised: true },
  { scope: 'weekly_reviews:write', description: 'Create, update, and delete weekly reviews.', exercised: true },
  { scope: 'comments:read', description: 'Read document comments.', exercised: true },
  { scope: 'comments:write', description: 'Post document comments.', exercised: true },
  { scope: 'webhooks:manage', description: 'Manage webhook subscriptions.', exercised: true },

  // Developer-platform administration (used by the Developer Portal's first-party
  // token exchange). Scope alone is not enough: the /api/v1 routes behind these
  // also require the token's user to be a workspace admin at request time.
  {
    scope: 'apps:manage',
    description:
      "Manage the workspace's OAuth apps: registration, secret rotation, deletion, and each app's webhook subscriptions and delivery log.",
    exercised: true,
  },
  {
    scope: 'connections:manage',
    description: "List and revoke connected apps' live tokens in the workspace.",
    exercised: true,
  },
  {
    scope: 'audit:read',
    description: "Read the workspace's public API audit trail.",
    exercised: true,
  },
  {
    scope: 'offline_access',
    description: 'Issue a refresh token so an installed integration can keep access after the one-hour access token expires.',
    exercised: true,
  },
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
