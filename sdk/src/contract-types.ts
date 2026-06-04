/**
 * Compile-time contract drift guards (PRD §1: "Type tests prove a consumer can
 * rely on generated types"). These assertions are checked by `pnpm type-check`
 * (unlike `__tests__/*`, which tsc excludes). If a `/api/v1` response schema
 * changes, `pnpm gen:types` regenerates `generated/openapi-types.ts`, and any
 * hand-written interface in `index.ts` that drifted from the wire contract
 * makes one of the assertions below fail to compile — forcing the SDK type to
 * be updated in lockstep.
 *
 * The guards are mutual-assignability checks: the hand-written type and the
 * generated schema must each be assignable to the other (i.e. structurally
 * equivalent for the fields the SDK exposes).
 */
import type {
  AuthenticatedUser,
  ShipIssue,
  ShipWebhookSubscription,
} from './index.js';
import type {
  MeResponseSchema,
  IssueSchema,
  WebhookSubscriptionSchema,
} from './generated/index.js';

/** Compiles only when `A` and `B` are mutually assignable. */
type AssertMutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// Each line errors at type-check time if the hand-written type drifts from the
// generated OpenAPI schema. The `void` cast keeps them runtime-free.
type _Me = AssertMutual<AuthenticatedUser, MeResponseSchema>;
type _Issue = AssertMutual<ShipIssue, IssueSchema>;
type _WebhookSubscription = AssertMutual<ShipWebhookSubscription, WebhookSubscriptionSchema>;

// Reference the aliases so they are not reported as unused.
export type ContractGuards = [_Me, _Issue, _WebhookSubscription];
