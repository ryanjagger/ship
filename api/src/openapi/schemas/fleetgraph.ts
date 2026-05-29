/**
 * FleetGraph chat schemas (U9) — on-demand context-scoped chat with read/draft/
 * confirmed-write autonomy. Streaming SSE turn + confirm/decline + conversation
 * fetch. Mirrors the registration pattern in fleet.ts.
 */

import { z, registry } from '../registry.js';
import { UuidSchema } from './common.js';

const FleetEntityTypeSchema = z.enum(['project', 'week']);

const FleetChatTurnRequestSchema = z
  .object({
    message: z.string().min(1).max(4000),
    entityId: UuidSchema,
    entityType: FleetEntityTypeSchema,
    conversationId: UuidSchema.optional().openapi({
      description: 'Continue an existing conversation (owner only); omit to start a new one.',
    }),
  })
  .openapi('FleetChatTurnRequest');

registry.register('FleetChatTurnRequest', FleetChatTurnRequestSchema);

const FleetConfirmRequestSchema = z
  .object({
    conversationId: UuidSchema,
    approved: z.boolean().openapi({ description: 'true confirms and applies the proposed write; false declines.' }),
  })
  .openapi('FleetConfirmRequest');

registry.register('FleetConfirmRequest', FleetConfirmRequestSchema);

const FleetTranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string(),
});

const FleetWriteProposalSchema = z
  .object({
    kind: z.enum(['create_issue', 'patch_issue', 'post_comment']),
    summary: z.string(),
    targetId: z.string().nullable(),
    args: z.record(z.unknown()),
    contentHash: z.string(),
  })
  .openapi('FleetWriteProposal');

const FleetConversationSchema = z
  .object({
    id: UuidSchema,
    entityId: UuidSchema.nullable(),
    entityType: FleetEntityTypeSchema.nullable(),
    transcript: z.array(FleetTranscriptTurnSchema),
    pendingProposal: FleetWriteProposalSchema.nullable().openapi({
      description: 'The structured write proposal awaiting confirmation (re-renderable card), or null when none is pending.',
    }),
  })
  .openapi('FleetConversation');

registry.register('FleetConversation', FleetConversationSchema);

registry.registerPath({
  method: 'get',
  path: '/fleetgraph/availability',
  tags: ['Fleet'],
  summary: 'Whether FleetGraph chat is available',
  description:
    'Lightweight provider gate for the client launcher: returns `{ available }` reflecting whether an AI provider is configured. The launcher hides itself when false rather than rendering a dead control.',
  responses: {
    200: {
      description: 'Availability flag',
      content: { 'application/json': { schema: z.object({ available: z.boolean() }) } },
    },
    401: { description: 'Unauthenticated' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/chat',
  tags: ['Fleet'],
  summary: 'Stream a FleetGraph chat turn (SSE)',
  description:
    'Runs one context-scoped chat turn against a Project or Week and streams the response as Server-Sent Events (Content-Type: text/event-stream). Consume via fetch + ReadableStream (NOT EventSource). Events: `token` (incremental answer), `final` (answer resolved), `paused` (a write proposal awaits confirmation — call /fleetgraph/chat/confirm). Requires a configured AI provider. Rate-limited per user.',
  request: {
    body: { content: { 'application/json': { schema: FleetChatTurnRequestSchema } } },
  },
  responses: {
    200: {
      description: 'SSE stream of token/final/paused events',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthenticated' },
    404: { description: 'Entity or conversation not found / not visible' },
    409: { description: 'A proposed change is awaiting confirmation on this conversation' },
    429: { description: 'Chat rate limit exceeded' },
    503: { description: 'No AI provider configured' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/chat/confirm',
  tags: ['Fleet'],
  summary: 'Confirm or decline a paused FleetGraph write',
  description:
    'Resumes a paused chat turn on the same conversation thread. `approved:true` applies the exact surfaced write (audited); `approved:false` abandons it. Owner-only: the caller must be the conversation creator in the same workspace (403 otherwise).',
  request: {
    body: { content: { 'application/json': { schema: FleetConfirmRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Resolved answer (write applied or declined)',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['answer', 'paused']),
            answer: z.string().optional(),
            conversationId: UuidSchema,
            executed: z.unknown().optional(),
            proposal: FleetWriteProposalSchema.optional().openapi({
              description: 'Present only on the defensive `paused` branch (resume failed to resolve); the write proposal still awaiting confirmation.',
            }),
          }),
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Not the conversation owner' },
    404: { description: 'Conversation not found' },
    409: { description: 'No pending proposal to confirm (already resolved)' },
    500: { description: 'Internal server error' },
    503: { description: 'No AI provider configured' },
  },
});

// ── dedup-review (stage-2, graph-backed duplicate verdict) ───────────────────

const FleetDedupCandidateSchema = z
  .object({
    id: UuidSchema,
    title: z.string(),
    ticket_number: z.number().int(),
    display_id: z.string(),
    state: z.string(),
    priority: z.string(),
    assignee_name: z.string().nullable(),
    project_title: z.string().nullable(),
    updated_at: z.string(),
    score: z.number().openapi({ description: 'pg_trgm similarity score (0–1)' }),
  })
  .openapi('FleetDedupCandidate');

const FleetDedupMatchSchema = z
  .object({
    candidate: FleetDedupCandidateSchema,
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  })
  .openapi('FleetDedupMatch');

const FleetDedupReviewSchema = z
  .object({
    candidates: z.array(FleetDedupCandidateSchema),
    matches: z.array(FleetDedupMatchSchema),
    summary: z.string().nullable(),
    recommendation: z.string().nullable(),
    ai_available: z.boolean(),
  })
  .openapi('FleetDedupReview');

registry.register('FleetDedupReview', FleetDedupReviewSchema);

const FleetDedupRequestSchema = z
  .object({
    title: z.string().min(1).max(500).openapi({ description: 'The in-progress issue title being typed', example: 'Fix login button not responding' }),
    excludeId: UuidSchema.openapi({ description: 'The draft issue id (excluded from candidates; the graph entityId)' }),
  })
  .openapi('FleetDedupRequest');

registry.register('FleetDedupRequest', FleetDedupRequestSchema);

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/dedup-review',
  tags: ['Fleet'],
  summary: 'Reason over similar issues for true duplicates (stage 2)',
  description:
    "Runs FleetGraph `dedup` mode: retrieves pg_trgm candidate open issues (the same set as GET /api/issues/similar), then has the model judge which are TRUE duplicates of the draft title (vs merely similar), with per-match confidence + reasons and a recommendation. On-demand (button click), not per keystroke — requires a configured AI provider and is rate-limited per user. Short-circuits with an empty verdict (no model call) when there are no candidates.",
  request: {
    body: { content: { 'application/json': { schema: FleetDedupRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Duplicate verdict (candidates + judged matches)',
      content: { 'application/json': { schema: FleetDedupReviewSchema } },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthenticated' },
    404: { description: 'Draft issue not found / not visible' },
    429: { description: 'Fleet rate limit exceeded' },
    503: { description: 'No AI provider configured' },
  },
});

// ── related-groups (theme-group the open-issue set) ──────────────────────────

const FleetIssueGroupCandidateSchema = z
  .object({
    id: UuidSchema,
    title: z.string(),
    ticket_number: z.number().int(),
    display_id: z.string(),
    state: z.string(),
    priority: z.string(),
    assignee_name: z.string().nullable(),
    project_title: z.string().nullable(),
    updated_at: z.string(),
    body: z.string().nullable().openapi({ description: 'Truncated plain-text description, or null.' }),
  })
  .openapi('FleetIssueGroupCandidate');

const FleetIssueGroupSchema = z
  .object({
    label: z.string().openapi({ description: 'Short theme label for the group.' }),
    memberIds: z.array(UuidSchema).openapi({ description: 'Issue ids in this group (≥2).' }),
    reason: z.string(),
  })
  .openapi('FleetIssueGroup');

const FleetIssueGroupingResultSchema = z
  .object({
    candidates: z.array(FleetIssueGroupCandidateSchema),
    groups: z.array(FleetIssueGroupSchema),
    ungroupedIds: z.array(UuidSchema),
    summary: z.string().nullable(),
    ai_available: z.boolean(),
    analyzed_count: z.number().int(),
    truncated: z.boolean().openapi({ description: 'True when open issues exceeded the analysis cap.' }),
  })
  .openapi('FleetIssueGroupingResult');

registry.register('FleetIssueGroupingResult', FleetIssueGroupingResultSchema);

registry.registerPath({
  method: 'get',
  path: '/fleetgraph/related-groups',
  tags: ['Fleet'],
  summary: 'Theme-group the workspace\'s open issues',
  description:
    "Powers the Issues page \"Related\" view. Runs FleetGraph `related` mode: fetches the requesting user's visible OPEN issues (recency-capped, with truncated descriptions) and has the model cluster them by shared theme/work area into groups (≥2 members each), leaving one-offs ungrouped. Read-only and workspace-wide (no request body). Provider-gated and rate-limited per user; results are cached server-side per issue-set fingerprint. Degrades to a candidates-only payload (ai_available:false) when the model is unavailable — the client then renders a flat list.",
  responses: {
    200: {
      description: 'Theme groups + the analyzed candidates + the ungrouped bucket',
      content: { 'application/json': { schema: FleetIssueGroupingResultSchema } },
    },
    401: { description: 'Unauthenticated' },
    429: { description: 'Fleet rate limit exceeded' },
    500: { description: 'Internal server error' },
    503: { description: 'No AI provider configured' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/fleetgraph/conversations/{id}',
  tags: ['Fleet'],
  summary: 'Fetch a FleetGraph conversation transcript',
  description:
    'Returns the conversation transcript and whether a write proposal is pending. Owner or workspace-admin only (transcripts hold fetched issue/standup/people content).',
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: {
      description: 'Conversation transcript',
      content: { 'application/json': { schema: FleetConversationSchema } },
    },
    401: { description: 'Unauthenticated' },
    403: { description: 'Not the owner or a workspace admin' },
    404: { description: 'Conversation not found' },
    500: { description: 'Internal server error' },
  },
});
