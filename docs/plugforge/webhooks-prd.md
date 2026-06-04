# Ship Webhooks PRD

## Summary

Ship will expose signed, retryable, replayable webhooks for public `/api/v1`
resource events. Public webhook events use Ship's typed public API model, not
the internal unified `documents` table. There are no public `document.*` events
in v1.

Webhook delivery is at-least-once. Subscribers must deduplicate by event
`id` or `idempotency_key`.

## Goals

- Let OAuth apps subscribe to Ship resource changes.
- Deliver HMAC-SHA256 signed HTTP POST requests.
- Retry transient delivery failures with exponential backoff and jitter.
- Dead-letter exhausted or permanent failures.
- Let developers inspect delivery history and manually replay events.
- Keep webhook publication domain-driven: writes publish events from the
  domain/write layer after a successful commit, not from route handlers.

## Non-Goals

- No inbound webhooks.
- No generic public `document.*` events.
- No exactly-once delivery guarantee.
- No queue-backed worker is required for v1, though the design must allow one
  later.
- No raw database rows or internal `document_type` payload model in public
  webhooks.

## Key Decisions

- Event names follow typed `/api/v1` resources: `issue.*`, `project.*`,
  `sprint.*`, `program.*`, `wiki_page.*`, `person.*`, `weekly_plan.*`,
  `weekly_retro.*`, `standup.*`, and `weekly_review.*`.
- `data.object` uses the same public DTO shape as the corresponding `/api/v1`
  resource.
- Delete events use a minimal tombstone payload instead of a stale full object.
- Signing secrets cannot be stored only as one-way hashes because HMAC signing
  requires the raw secret. Store an encrypted secret plus a non-secret
  fingerprint for display and audit.

## Event Registry

Every event type is registered as data with:

- `type`
- `description`
- `resource`
- required subscription read scopes
- Zod payload schema
- OpenAPI/schema export metadata

### V1 Events

| Resource | Events |
| --- | --- |
| Issue | `issue.created`, `issue.updated`, `issue.deleted`, `issue.assigned`, `issue.status_changed` |
| Project | `project.created`, `project.updated`, `project.deleted`, `project.completed` |
| Sprint | `sprint.created`, `sprint.updated`, `sprint.deleted`, `sprint.started`, `sprint.completed` |
| Program | `program.created`, `program.updated`, `program.deleted` |
| Wiki page | `wiki_page.created`, `wiki_page.updated`, `wiki_page.deleted` |
| Person | `person.created`, `person.updated`, `person.deleted` |
| Weekly plan | `weekly_plan.created`, `weekly_plan.updated`, `weekly_plan.deleted`, `weekly_plan.submitted` |
| Weekly retro | `weekly_retro.created`, `weekly_retro.updated`, `weekly_retro.deleted`, `weekly_retro.submitted` |
| Standup | `standup.created`, `standup.updated`, `standup.deleted`, `standup.submitted` |
| Weekly review | `weekly_review.created`, `weekly_review.updated`, `weekly_review.deleted` |

### Scope Requirements

Creating or managing subscriptions always requires `webhooks:manage`.
Subscribing to a resource family also requires the matching read scope.

| Event family | Required read scope |
| --- | --- |
| `issue.*` | `issues:read` or `documents:read` |
| `project.*` | `projects:read` or `documents:read` |
| `sprint.*` | `sprints:read` or `documents:read` |
| `program.*` | `programs:read` or `documents:read` |
| `wiki_page.*` | `wiki:read` or `documents:read` |
| `person.*` | `people:read` |
| `weekly_plan.*` | `weekly_plans:read` or `documents:read` |
| `weekly_retro.*` | `weekly_retros:read` or `documents:read` |
| `standup.*` | `standups:read` or `documents:read` |
| `weekly_review.*` | `weekly_reviews:read` or `documents:read` |

`person.*` intentionally does not accept `documents:read` as a broad fallback
until product/security explicitly decides directory events are safe under the
broad document scope.

## Event Semantics

Every mutable typed `/api/v1` resource emits `created`, `updated`, and
`deleted`.

Semantic events are emitted in addition to the generic resource update event
when a meaningful workflow transition happens:

- `issue.assigned`: `assignee_id` changes from one value to another, including
  null to non-null and non-null to null.
- `issue.status_changed`: issue `state` changes.
- `project.completed`: project transitions into a completed state.
- `sprint.started`: sprint `status` transitions to `active`.
- `sprint.completed`: sprint `status` transitions to `completed`.
- `weekly_plan.submitted`: `submitted_at` changes from null/missing to present.
- `weekly_retro.submitted`: `submitted_at` changes from null/missing to present,
  or the retro's submitted/completed field used by the public DTO changes to
  present.
- `standup.submitted`: `submitted_at` changes from null/missing to present.

If a single write triggers both a resource update and a semantic event, Ship may
emit both. Subscribers should treat events as independent facts and dedupe by
event id.

## Payload Shape

All events use this envelope:

```json
{
  "id": "evt_01J...",
  "type": "issue.status_changed",
  "api_version": "2026-06-03",
  "created": 1780500000,
  "workspace_id": "uuid",
  "actor_user_id": "uuid",
  "idempotency_key": "evt_01J...",
  "data": {
    "object": {}
  },
  "previous_attributes": {}
}
```

Fields:

- `id`: stable event id.
- `type`: event type from the registry.
- `api_version`: webhook payload contract version.
- `created`: Unix seconds when the event was created.
- `workspace_id`: workspace where the event occurred.
- `actor_user_id`: user whose action caused the event, when known.
- `idempotency_key`: stable dedupe key; defaults to the event id.
- `data.object`: public DTO for the resource.
- `previous_attributes`: changed fields for update/semantic events.

### Delete Payload

Delete events use a tombstone instead of the full deleted object:

```json
{
  "id": "person_id",
  "object": "person",
  "deleted": true
}
```

The tombstone avoids leaking stale resource snapshots after deletion while still
letting subscribers reconcile local records.

## Event Bus

Add an `IEventBus` interface:

```ts
export interface IEventBus {
  publish(event: ShipWebhookEvent): Promise<void>;
}
```

Requirements:

- Domain/write layer publishes after successful commit.
- Route handlers do not manually construct webhook deliveries.
- In-process implementation must ship.
- Queue-backed implementation must be a drop-in replacement later.
- Event payload construction must be resource-aware and use public DTO mapping.

Implementation note: current typed public routes contain inline write logic.
Introducing webhooks should extract shared write/domain helpers where needed so
publication sits behind the write boundary rather than inside route handlers.

## Subscriptions API

Subscriptions are per OAuth app, workspace, target URL, and event set.

Routes:

```text
GET    /api/v1/webhooks
POST   /api/v1/webhooks
GET    /api/v1/webhooks/:id
PATCH  /api/v1/webhooks/:id
DELETE /api/v1/webhooks/:id
POST   /api/v1/webhooks/:id/rotate-secret
```

All routes require:

```text
Authorization: Bearer <token>
scope: webhooks:manage
```

### Create Subscription Request

```json
{
  "url": "https://example.com/ship/webhooks",
  "events": ["issue.created", "issue.status_changed"],
  "active": true
}
```

### Create Subscription Response

```json
{
  "id": "uuid",
  "url": "https://example.com/ship/webhooks",
  "events": ["issue.created", "issue.status_changed"],
  "active": true,
  "secret": "whsec_...",
  "secret_fingerprint": "sha256:...",
  "created_at": "2026-06-03T00:00:00.000Z",
  "updated_at": "2026-06-03T00:00:00.000Z"
}
```

The raw `secret` is returned only on create and rotation.

## Signing

Outbound webhook requests include:

```text
Content-Type: application/json
Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>
Ship-Event-Id: <event-id>
Idempotency-Key: <event-id>
```

Signature input:

```text
<timestamp>.<raw-json-body>
```

Algorithm: HMAC-SHA256.

SDK verification defaults:

- Reject malformed headers.
- Reject signatures without `t` or `v1`.
- Reject timestamps older than 5 minutes.
- Compare signatures in constant time.
- Verify against the raw request body, not parsed JSON.

Signer unit suite:

- positive verification
- wrong secret
- malformed header
- stale timestamp replay rejection
- tampered payload rejection
- wrong raw body serialization rejection

## Retries

Retry on:

- timeout
- network error
- HTTP 5xx

Do not retry:

- HTTP 2xx success
- HTTP 4xx permanent failure

Retry schedule with jitter:

```text
1s, 4s, 16s, 1m, 5m, 30m
```

Define this as initial attempt plus six retries. If the final retry fails, the
delivery moves to the dead-letter queue.

## Dead-Letter Queue

Deliveries enter the DLQ when:

- a 4xx response marks the delivery as a permanent failure
- all retry attempts are exhausted

DLQ entries are visible in the developer portal and through delivery log APIs.
Authenticated developers with `webhooks:manage` can replay them manually.

## Delivery Log And Replay

Routes:

```text
GET  /api/v1/webhook-deliveries
GET  /api/v1/webhook-deliveries/:id
POST /api/v1/webhook-deliveries/:id/replay
```

Delivery records include:

- `id`
- `subscription_id`
- `event_id`
- `event_type`
- `status`: `pending`, `delivered`, `failed`, `dead_lettered`, `replayed`
- `attempt_count`
- `last_response_status`
- `last_response_body_excerpt`
- `last_error`
- `next_attempt_at`
- `created_at`
- `updated_at`

Attempt records include:

- `id`
- `delivery_id`
- `subscription_id`
- `event_id`
- `attempt_number`
- `response_status`
- `response_body_excerpt`
- `duration_ms`
- `error`
- `sent_at`

Manual replay sends the original event and original idempotency key with a fresh
signature timestamp. Replay creates a new delivery/attempt trail linked back to
the original delivery.

## Persistence

Minimum tables:

- `webhook_subscriptions`
- `webhook_events`
- `webhook_deliveries`
- `webhook_delivery_attempts`

### webhook_subscriptions

Stores per-app subscriptions:

- `id`
- `app_id`
- `workspace_id`
- `url`
- `events`
- `encrypted_secret`
- `secret_fingerprint`
- `active`
- `created_at`
- `updated_at`

### webhook_events

Immutable event store:

- `id`
- `workspace_id`
- `actor_user_id`
- `type`
- `api_version`
- `payload`
- `idempotency_key`
- `created_at`

### webhook_deliveries

Current delivery state per subscription/event pair:

- `id`
- `subscription_id`
- `event_id`
- `status`
- `attempt_count`
- `next_attempt_at`
- `last_attempt_at`
- `delivered_at`
- `dead_lettered_at`
- `replay_of_delivery_id`
- `created_at`
- `updated_at`

### webhook_delivery_attempts

Append-only attempt history:

- `id`
- `delivery_id`
- `subscription_id`
- `event_id`
- `attempt_number`
- `response_status`
- `response_body_excerpt`
- `duration_ms`
- `error`
- `sent_at`

## Developer Portal

The developer portal should support:

- list webhook subscriptions
- create/edit/deactivate/delete subscriptions
- rotate signing secret
- show secret once on create/rotation
- browse delivery log
- filter by subscription, event type, and status
- inspect attempt history
- replay failed/dead-lettered deliveries

## SDK

SDK must include a webhook verifier:

```ts
verifyWebhook(headers, rawBody, secret): boolean
```

The verifier must:

- parse `Ship-Signature`
- enforce the default 5 minute tolerance
- accept a configurable tolerance
- use constant-time comparison
- verify the raw body bytes/string exactly as received

SDK docs should include examples for Express and a generic Fetch/Request style
handler.

## Testing

Must include:

- event registry schema tests
- subscription route tests for `webhooks:manage`
- subscription route tests for missing resource read scopes
- signer positive verification
- signer negative verification
- stale timestamp replay rejection
- tampered payload rejection
- malformed header rejection
- retry scheduling
- 4xx permanent failure behavior
- 5xx retry behavior
- timeout retry behavior
- DLQ after exhausted attempts
- replay preserves original idempotency key
- replay uses a fresh signature timestamp
- typed resource mutation emits the expected event type
- no public event type exposes `document.*`

## Acceptance Criteria

- Every mutable typed `/api/v1` resource emits `created`, `updated`, and
  `deleted`.
- Issue assignment emits `issue.assigned`.
- Issue state change emits `issue.status_changed`.
- Project completion emits `project.completed`.
- Sprint status transitions emit `sprint.started` and `sprint.completed`.
- Submitted weekly plans, retros, and standups emit semantic submitted events.
- Apps can create subscriptions through `/api/v1/webhooks`.
- Subscribers receive signed POST requests.
- The SDK verifies valid webhook signatures and rejects tampered payloads.
- Failed transient deliveries retry on the configured schedule.
- Permanent failures are visible in delivery history.
- Developers can manually replay DLQ deliveries.
- Replays carry the original idempotency key.
- No public webhook exposes raw `document_type` as the event model.

## Open Questions

- What exact field defines `project.completed`: inferred status, explicit
  `is_complete`, `plan_validated`, or another product-level transition?
- What exact public DTO field defines `weekly_retro.submitted` today?
- Should `documents:read` eventually permit `person.*`, or should directory
  events always require `people:read`?
- Should replay create a new delivery id linked to the original delivery, or
  append attempts to the original delivery? This PRD recommends a new linked
  delivery for audit clarity.
