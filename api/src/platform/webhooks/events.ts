import crypto from 'crypto';
import type { ResourceDto, TypedDocumentResource } from '../api/v1/schemas/typed-document.js';
import { WEBHOOK_API_VERSION } from './registry.js';

/**
 * Event envelope construction (PRD §Payload Shape).
 *
 * `buildEvents` is pure — given a resource, an actor, and a before/after DTO pair
 * (the public `toResponse` output), it returns the events to publish. A create
 * yields one `created` event; an update yields the base `updated` event PLUS any
 * semantic events the resource detects, each an independent fact with its own id;
 * a delete yields one `deleted` event carrying a tombstone, not the stale object.
 */

export interface ShipWebhookEvent {
  id: string;
  type: string;
  api_version: string;
  created: number;
  workspace_id: string;
  actor_user_id: string | null;
  idempotency_key: string;
  data: { object: unknown };
  previous_attributes?: Record<string, unknown>;
}

export interface EventActor {
  workspaceId: string;
  actorUserId: string | null;
}

export type ResourceChange =
  | { kind: 'created'; after: ResourceDto }
  | { kind: 'updated'; before: ResourceDto; after: ResourceDto }
  | { kind: 'deleted'; id: string };

function newEventId(): string {
  return `evt_${crypto.randomBytes(16).toString('hex')}`;
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // DTO values are JSON-serializable and produced by the same mapper, so key
  // order is stable — a structural JSON compare is sufficient and cheap.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Changed fields as `field → previous value` (Stripe `previous_attributes`
 * convention): the keys are what changed, the values are the prior values.
 */
export function diffAttributes(before: ResourceDto, after: ResourceDto): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!deepEqual(before[key], after[key])) changed[key] = before[key] ?? null;
  }
  return changed;
}

function makeEvent(
  type: string,
  actor: EventActor,
  object: unknown,
  previousAttributes?: Record<string, unknown>
): ShipWebhookEvent {
  const id = newEventId();
  const event: ShipWebhookEvent = {
    id,
    type,
    api_version: WEBHOOK_API_VERSION,
    created: nowUnixSeconds(),
    workspace_id: actor.workspaceId,
    actor_user_id: actor.actorUserId,
    idempotency_key: id,
    data: { object },
  };
  if (previousAttributes && Object.keys(previousAttributes).length > 0) {
    event.previous_attributes = previousAttributes;
  }
  return event;
}

export function buildEvents(
  resource: Pick<TypedDocumentResource, 'eventResource' | 'semanticEvents'>,
  actor: EventActor,
  change: ResourceChange
): ShipWebhookEvent[] {
  const family = resource.eventResource;

  if (change.kind === 'created') {
    return [makeEvent(`${family}.created`, actor, change.after)];
  }

  if (change.kind === 'deleted') {
    return [makeEvent(`${family}.deleted`, actor, { id: change.id, object: family, deleted: true })];
  }

  // updated: base update event + any semantic events, each independent.
  const previous = diffAttributes(change.before, change.after);
  const events: ShipWebhookEvent[] = [makeEvent(`${family}.updated`, actor, change.after, previous)];
  for (const action of resource.semanticEvents?.(change.before, change.after) ?? []) {
    events.push(makeEvent(`${family}.${action}`, actor, change.after, previous));
  }
  return events;
}
