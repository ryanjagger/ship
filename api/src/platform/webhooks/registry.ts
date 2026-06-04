import { z } from 'zod';
import { TYPED_DOCUMENT_RESOURCES } from '../api/v1/schemas/typed-document.js';

/**
 * Webhook event registry (PRD §Event Registry).
 *
 * Every public event type is registered as data: its family resource, required
 * subscription read scopes, a human description, and whether it is emitted yet.
 * Subscriptions may only target known event types, and the read scope a family
 * requires gates who may subscribe. There are NO public `document.*` events.
 *
 * Read scopes per PRD §Scope Requirements: each family accepts its typed read
 * scope OR `documents:read` — EXCEPT `person.*`, which requires `people:read`
 * with no broad-document fallback (directory data is more sensitive).
 */

export interface WebhookEventDefinition {
  /** Fully-qualified event type, e.g. `issue.status_changed`. */
  type: string;
  /** Event family / tombstone object name, e.g. `issue`. */
  resource: string;
  description: string;
  /** Acceptable read scopes — a subscriber needs ANY one of these. */
  readScopes: string[];
  /**
   * Whether the platform emits this event today. A few semantic events
   * (`sprint.started`/`sprint.completed`/`project.completed`) depend on
   * read-time-inferred status and are registered but deferred (PRD decision).
   */
  emitted: boolean;
}

/** The lifecycle events every mutable typed resource emits. */
const LIFECYCLE: Array<{ action: string; describe: (r: string) => string }> = [
  { action: 'created', describe: (r) => `A ${r} was created.` },
  { action: 'updated', describe: (r) => `A ${r} was updated.` },
  { action: 'deleted', describe: (r) => `A ${r} was deleted.` },
];

/**
 * Semantic events keyed by event family. `emitted: false` marks types that are
 * registered (so subscriptions can be created) but not yet produced.
 */
const SEMANTIC: Record<string, Array<{ action: string; description: string; emitted: boolean }>> = {
  issue: [
    { action: 'assigned', description: 'An issue assignee changed.', emitted: true },
    { action: 'status_changed', description: 'An issue state changed.', emitted: true },
  ],
  project: [{ action: 'completed', description: 'A project was completed.', emitted: false }],
  sprint: [
    { action: 'started', description: 'A sprint became active.', emitted: false },
    { action: 'completed', description: 'A sprint was completed.', emitted: false },
  ],
  weekly_plan: [{ action: 'submitted', description: 'A weekly plan was submitted.', emitted: true }],
  weekly_retro: [{ action: 'submitted', description: 'A weekly retro was submitted.', emitted: true }],
  standup: [{ action: 'submitted', description: 'A standup was submitted.', emitted: true }],
};

/** A family accepts its typed read scope, plus `documents:read` except for people. */
function readScopesFor(eventResource: string, typedReadScope: string): string[] {
  return eventResource === 'person' ? [typedReadScope] : [typedReadScope, 'documents:read'];
}

function buildRegistry(): Map<string, WebhookEventDefinition> {
  const byType = new Map<string, WebhookEventDefinition>();
  for (const resource of TYPED_DOCUMENT_RESOURCES) {
    const family = resource.eventResource;
    const readScopes = readScopesFor(family, resource.readScope);
    for (const { action, describe } of LIFECYCLE) {
      const type = `${family}.${action}`;
      byType.set(type, { type, resource: family, description: describe(resource.name), readScopes, emitted: true });
    }
    for (const semantic of SEMANTIC[family] ?? []) {
      const type = `${family}.${semantic.action}`;
      byType.set(type, {
        type,
        resource: family,
        description: semantic.description,
        readScopes,
        emitted: semantic.emitted,
      });
    }
  }
  return byType;
}

const REGISTRY = buildRegistry();

export function getEventDefinition(type: string): WebhookEventDefinition | undefined {
  return REGISTRY.get(type);
}

export function isKnownEventType(type: string): boolean {
  return REGISTRY.has(type);
}

/** All registered event types (including the not-yet-emitted ones). */
export function allEventTypes(): string[] {
  return [...REGISTRY.keys()];
}

export function listEventDefinitions(): WebhookEventDefinition[] {
  return [...REGISTRY.values()];
}

/** Read scopes required to subscribe to `type` (any-of). Empty if unknown. */
export function requiredReadScopes(type: string): string[] {
  return REGISTRY.get(type)?.readScopes ?? [];
}

// ─── Payload schemas (OpenAPI/schema export + tests) ──────────────────────────

export const WEBHOOK_API_VERSION = '2026-06-03';

/** The tombstone `data.object` used by every `*.deleted` event. */
export const TombstoneSchema = z.object({
  id: z.string(),
  object: z.string(),
  deleted: z.literal(true),
});

/** The signed envelope shape shared by every event (PRD §Payload Shape). */
export const WebhookEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  api_version: z.string(),
  created: z.number().int(),
  workspace_id: z.string(),
  actor_user_id: z.string().nullable(),
  idempotency_key: z.string(),
  data: z.object({ object: z.unknown() }),
  previous_attributes: z.record(z.unknown()).optional(),
});
