/**
 * Operation manifest (PRD §1, Phase 0): maps every public OpenAPI operation to
 * the SDK method that implements it. The contract drift test
 * (`__tests__/contract.test.ts`) walks the committed `docs/openapi.json` and
 * fails if any operation is missing here — that is the "0 drift in CI" gate.
 *
 * The Platform API OpenAPI generator (`OpenApiGeneratorV31`) does NOT emit
 * `operationId`s, so operations are keyed by `"<METHOD> <path>"` (uppercased
 * method, path template exactly as it appears under `paths` in the spec).
 *
 * `sdkMethod` is documentation only (e.g. `client.issues.list`); set
 * `unsupported: true` with a `reason` to intentionally exclude an operation.
 */

export interface ManifestEntry {
  /** Dotted SDK accessor that implements the operation, for docs/debugging. */
  sdkMethod: string;
  /** Mark an operation intentionally not exposed by the SDK. */
  unsupported?: boolean;
  reason?: string;
}

/** Build the `"<METHOD> <path>"` key used throughout the manifest + drift test. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * For the typed document resources the SDK exposes one `TypedResourceClient`
 * per path segment; this records the five CRUD operations each one covers.
 */
function typedResource(path: string, accessor: string): Record<string, ManifestEntry> {
  return {
    [operationKey('GET', `/${path}`)]: { sdkMethod: `client.${accessor}.list / .iterate` },
    [operationKey('POST', `/${path}`)]: { sdkMethod: `client.${accessor}.create` },
    [operationKey('GET', `/${path}/{id}`)]: { sdkMethod: `client.${accessor}.get` },
    [operationKey('PATCH', `/${path}/{id}`)]: { sdkMethod: `client.${accessor}.update` },
    [operationKey('DELETE', `/${path}/{id}`)]: { sdkMethod: `client.${accessor}.delete` },
  };
}

export const OPERATION_MANIFEST: Record<string, ManifestEntry> = {
  [operationKey('GET', '/me')]: { sdkMethod: 'client.me' },

  // Legacy broad document surface.
  [operationKey('GET', '/documents')]: { sdkMethod: 'client.documents.list / .iterate' },
  [operationKey('POST', '/documents')]: { sdkMethod: 'client.documents.create' },
  [operationKey('GET', '/documents/{id}')]: { sdkMethod: 'client.documents.get' },

  // Typed document resources.
  ...typedResource('wiki-pages', 'wikiPages'),
  ...typedResource('issues', 'issues'),
  ...typedResource('programs', 'programs'),
  ...typedResource('projects', 'projects'),
  ...typedResource('sprints', 'sprints'),
  ...typedResource('people', 'people'),
  ...typedResource('weekly-plans', 'weeklyPlans'),
  ...typedResource('weekly-retros', 'weeklyRetros'),
  ...typedResource('standups', 'standups'),
  ...typedResource('weekly-reviews', 'weeklyReviews'),

  // Webhook subscriptions.
  [operationKey('GET', '/webhooks')]: { sdkMethod: 'client.webhooks.list' },
  [operationKey('POST', '/webhooks')]: { sdkMethod: 'client.webhooks.create' },
  [operationKey('GET', '/webhooks/{id}')]: { sdkMethod: 'client.webhooks.get' },
  [operationKey('PATCH', '/webhooks/{id}')]: { sdkMethod: 'client.webhooks.update' },
  [operationKey('DELETE', '/webhooks/{id}')]: { sdkMethod: 'client.webhooks.delete' },
  [operationKey('POST', '/webhooks/{id}/rotate-secret')]: { sdkMethod: 'client.webhooks.rotateSecret' },

  // Webhook delivery log + replay.
  [operationKey('GET', '/webhook-deliveries')]: { sdkMethod: 'client.webhooks.deliveries.list' },
  [operationKey('GET', '/webhook-deliveries/{id}')]: { sdkMethod: 'client.webhooks.deliveries.get' },
  [operationKey('POST', '/webhook-deliveries/{id}/replay')]: { sdkMethod: 'client.webhooks.deliveries.replay' },
};
