import { isKnownEventType, requiredReadScopes } from './registry.js';
import { webhookTargetError } from './target-url.js';

/**
 * Validate URL + event types for a subscription managed ON BEHALF OF an app
 * (the Developer Portal's per-app admin path, internal or /api/v1/apps/:appId).
 * Mirrors the read-scope gate on the self-service `/api/v1/webhooks` path
 * (PRD §Scope Requirements): an app may only subscribe to an event family it
 * holds a read scope for. Here the app — not the bearer token — is the
 * subscriber, so we gate on the TARGET app's `requested_scopes`, never on the
 * caller's granted scopes. Without this, fan-out (`eventBus.publish` matches
 * only workspace/active/events) would deliver e.g. `issue.*` payloads to an
 * app lacking `issues:read`.
 */
export function validateSubscriptionForApp(
  url: string | undefined,
  events: string[] | undefined,
  appScopes: string[]
): string | null {
  if (url !== undefined) {
    const urlError = webhookTargetError(url);
    if (urlError) return `Invalid webhook url: ${urlError}`;
  }
  if (events !== undefined) {
    const unknownEvents = events.filter((e) => !isKnownEventType(e));
    if (unknownEvents.length > 0) return `Unknown event type(s): ${unknownEvents.join(', ')}`;
    const granted = new Set(appScopes);
    for (const event of events) {
      const accepted = requiredReadScopes(event);
      if (accepted.length > 0 && !accepted.some((scope) => granted.has(scope))) {
        return `Subscribing to "${event}" requires the app to hold one of: ${accepted.join(', ')}.`;
      }
    }
  }
  return null;
}
