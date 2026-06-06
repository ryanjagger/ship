/**
 * Re-exports of the generated Platform API OpenAPI types (PRD §1). The raw file
 * `openapi-types.ts` is regenerated from the committed `docs/openapi.json` via
 * `pnpm gen:types` and must never be hand-edited. These aliases give consumers
 * (and the SDK's own contract checks) ergonomic names without depending on the
 * generated file's internal `paths`/`components` shape directly.
 */
import type { paths, components } from './openapi-types.js';

export type { paths, components };

/** All response/request component schemas, keyed by their OpenAPI name. */
export type Schemas = components['schemas'];

/** A single OpenAPI schema by name, e.g. `Schema<'Issue'>`. */
export type Schema<Name extends keyof Schemas> = Schemas[Name];

// Convenience aliases for the resources the SDK exposes. These are the
// authoritative wire shapes; the hand-written interfaces in `index.ts` are
// ergonomic mirrors validated against these by `contract-types.ts`.
export type ApiErrorSchema = Schema<'ApiError'>;
export type MeResponseSchema = Schema<'MeResponse'>;
export type IssueSchema = Schema<'Issue'>;
export type SprintSchema = Schema<'Sprint'>;
export type ProjectSchema = Schema<'Project'>;
export type ProgramSchema = Schema<'Program'>;
export type WikiPageSchema = Schema<'WikiPage'>;
export type PersonSchema = Schema<'Person'>;
export type WebhookSubscriptionSchema = Schema<'WebhookSubscription'>;
export type WebhookDeliverySchema = Schema<'WebhookDelivery'>;
export type ScopeListSchema = Schema<'ScopeList'>;
export type OAuthAppListSchema = Schema<'OAuthAppList'>;
export type CreatedOAuthAppSchema = Schema<'CreatedOAuthApp'>;
export type ConnectionListSchema = Schema<'ConnectionList'>;
export type RevokeConnectionResponseSchema = Schema<'RevokeConnectionResponse'>;
export type AuditLogListSchema = Schema<'AuditLogList'>;
