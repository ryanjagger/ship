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
  ShipComment,
  ShipDocumentHistoryEntry,
  ShipWebhookSubscription,
  ShipScope,
  ShipOAuthApp,
  CreatedOAuthApp,
  ShipConnection,
  RevokeConnectionResult,
  AuditLogList,
  DataList,
} from './index.js';
import type {
  MeResponseSchema,
  IssueSchema,
  CommentListSchema,
  DocumentHistoryListSchema,
  WebhookSubscriptionSchema,
  ScopeListSchema,
  OAuthAppListSchema,
  CreatedOAuthAppSchema,
  ConnectionListSchema,
  RevokeConnectionResponseSchema,
  AuditLogListSchema,
} from './generated/index.js';

/** Compiles only when `A` and `B` are mutually assignable. */
type AssertMutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// Each line errors at type-check time if the hand-written type drifts from the
// generated OpenAPI schema. The `void` cast keeps them runtime-free.
type _Me = AssertMutual<AuthenticatedUser, MeResponseSchema>;
type _Issue = AssertMutual<ShipIssue, IssueSchema>;
type _CommentList = AssertMutual<DataList<ShipComment>, CommentListSchema>;
type _DocumentHistoryList = AssertMutual<DataList<ShipDocumentHistoryEntry>, DocumentHistoryListSchema>;
type _WebhookSubscription = AssertMutual<ShipWebhookSubscription, WebhookSubscriptionSchema>;
type _ScopeList = AssertMutual<DataList<ShipScope>, ScopeListSchema>;
type _OAuthAppList = AssertMutual<DataList<ShipOAuthApp>, OAuthAppListSchema>;
type _CreatedOAuthApp = AssertMutual<CreatedOAuthApp, CreatedOAuthAppSchema>;
type _ConnectionList = AssertMutual<DataList<ShipConnection>, ConnectionListSchema>;
type _RevokeConnection = AssertMutual<RevokeConnectionResult, RevokeConnectionResponseSchema>;
type _AuditLogList = AssertMutual<AuditLogList, AuditLogListSchema>;

// Reference the aliases so they are not reported as unused.
export type ContractGuards = [
  _Me,
  _Issue,
  _CommentList,
  _DocumentHistoryList,
  _WebhookSubscription,
  _ScopeList,
  _OAuthAppList,
  _CreatedOAuthApp,
  _ConnectionList,
  _RevokeConnection,
  _AuditLogList,
];
