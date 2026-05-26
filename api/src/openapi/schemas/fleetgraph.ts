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
