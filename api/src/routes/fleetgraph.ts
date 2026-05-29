/**
 * U9 — FleetGraph chat endpoints.
 *
 *   POST /api/fleetgraph/chat            — streaming SSE turn (read/draft/propose)
 *   POST /api/fleetgraph/chat/confirm    — resume a paused turn (confirm/decline)
 *   GET  /api/fleetgraph/conversations/:id — fetch a conversation transcript
 *
 * All routes are under `authMiddleware` (+ `conditionalCsrf`, applied at mount in
 * app.ts). The graph requires a configured AI provider; with
 * `FLEET_AI_PROVIDER=none` the chat endpoints report `503 unavailable` (R18).
 *
 * ── SSE transport ──────────────────────────────────────────────────────────
 * The chat-turn route streams Server-Sent Events. The client (U10) consumes it
 * via `fetch` + `ReadableStream` (NOT `EventSource`, which is GET-only and can't
 * send the CSRF header). A `GET` to the chat route returns 405.
 *
 * Compression bypass (R11): the GLOBAL `compression()` middleware (mounted before
 * all routers in app.ts) would BUFFER the stream. We disable it CONCRETELY on the
 * route by setting `Content-Type: text/event-stream` + `Cache-Control:
 * no-transform` BEFORE the first write — `no-transform` instructs the compression
 * middleware (and CloudFront) not to transform/buffer the body. This is the
 * least-blast-radius choice (route-local, no global filter). The CloudFront
 * `ordered_cache_behavior` for `/api/fleetgraph/chat` (compress=false, ttl=0,
 * headers=*) is owned by U9 in terraform/s3-cloudfront.tf.
 *
 * ── Abort on disconnect ──────────────────────────────────────────────────────
 * `req.on('close')` aborts an `AbortController` whose signal is threaded into the
 * graph run via `config.signal`, so a client disconnect aborts the run.
 *
 * ── Confirmed-write authorization (P0, R9) ───────────────────────────────────
 * The confirm route and the conversation GET both load the conversation by id and
 * assert ownership BEFORE doing anything: confirm requires `created_by ===
 * req.userId AND workspace_id === req.workspaceId` (403 otherwise); GET requires
 * the same OR a workspace admin. Without this, any authenticated workspace member
 * could resume another user's paused write or read their transcript.
 *
 * ── One in-flight turn per conversation (U3 precondition) ─────────────────────
 * A second chat turn fired on a conversation whose checkpoint already holds a
 * pending proposal would overwrite the paused checkpoint (the U3 checkpointer is
 * latest-tuple-only). The chat route rejects (409) a new turn while a proposal is
 * pending; the user must confirm/decline first.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, assertAuthed } from '../middleware/auth.js';
import { getVisibilityContext, isWorkspaceAdmin } from '../middleware/visibility.js';
import { isFleetGraphAvailable } from '../services/fleetgraph/model.js';
import { streamChatTurn, resumeChatTurn, runDedupReview, runRelatedGroups, type ChatStreamEvent } from '../services/fleetgraph/index.js';
import { fetchFocal, type FleetEntityType } from '../services/fleetgraph/tools/read.js';
import {
  createConversation,
  getConversation,
  appendTurn,
  setPending,
  isPending,
  claimPending,
  getPendingProposal,
} from '../services/fleetgraph/conversation.js';
import { checkFleetChatRateLimit } from '../services/fleetgraph/rate-limit.js';
import { getCompiledGraph } from '../services/fleetgraph/graph.js';

const router = Router();

const entityTypeSchema = z.enum(['project', 'week', 'issue']);

const chatTurnSchema = z.object({
  message: z.string().min(1).max(4000),
  entityId: z.string().uuid(),
  entityType: entityTypeSchema,
  /** Optional existing conversation to continue; omit to start a new one. */
  conversationId: z.string().uuid().optional(),
});

const confirmSchema = z.object({
  conversationId: z.string().uuid(),
  approved: z.boolean(),
});

const dedupRequestSchema = z.object({
  /** The in-progress issue title being typed. */
  title: z.string().min(1).max(500),
  /** The draft issue's id (excluded from candidates; the graph entityId). */
  excludeId: z.string().uuid(),
});

/** Provider gate (R18): chat is unavailable when no AI provider is configured. */
function assertProviderAvailable(res: Response): boolean {
  if (!isFleetGraphAvailable()) {
    res.status(503).json({ error: 'FleetGraph chat requires an AI provider — contact your admin.' });
    return false;
  }
  return true;
}

/** Serialize a stream event as an SSE frame. */
function sseFrame(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// ── GET /availability — lightweight provider gate for the client launcher ────
// The web launcher hides itself when no provider is configured (rather than
// rendering a dead control). This is the cheap probe it polls; the heavier
// chat/confirm routes still 503 independently via assertProviderAvailable.
router.get('/availability', authMiddleware, (_req, res) => {
  res.json({ available: isFleetGraphAvailable() });
});

// ── POST /chat — reject GET (405); stream SSE on POST ────────────────────────

router.get('/chat', (_req, res) => {
  // EventSource (GET) is not supported — the client uses fetch + ReadableStream
  // so it can send the CSRF header. Reject GET explicitly.
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Use POST with fetch + ReadableStream (not EventSource).' });
});

router.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  if (!assertAuthed(req, res)) return;
  if (!assertProviderAvailable(res)) return;

  const parsed = chatTurnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid chat request', details: parsed.error.flatten() });
    return;
  }
  const { message, entityId, entityType, conversationId: existingId } = parsed.data;
  const userId = req.userId;
  const workspaceId = req.workspaceId;

  try {
    const { isAdmin } = await getVisibilityContext(userId, workspaceId);
    const ctx = { workspaceId, userId, isAdmin };

    // Authorize the focal entity (no leak): a non-visible / nonexistent entity is
    // a 404 — same posture as the fleet plan-review route.
    const focal = await fetchFocal(entityId, entityType as FleetEntityType, ctx);
    if (!focal) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    // ── Resolve / create the conversation BEFORE graph entry ──
    // The row must exist before the first turn (U7: the checkpointer UPDATEs by
    // id; absent → checkpoint silently dropped). Continuing an existing
    // conversation requires ownership (P0); it must also discuss this entity.
    let conversationId: string;
    if (existingId) {
      const conv = await getConversation(existingId);
      if (!conv || conv.workspaceId !== workspaceId || conv.createdBy !== userId) {
        // Owner-only continuation; don't leak existence of another's conversation.
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      conversationId = conv.id;

      // One-in-flight-turn (U3 precondition): reject a new turn while a proposal
      // is pending. We use the conversation's own `fleetgraph_pending` marker (set
      // when a turn pauses, cleared on confirm/decline) rather than the LangGraph
      // checkpoint's pending writes, which are unreliable across turns on the
      // process-wide singleton graph.
      const pending = await isPending(conversationId);
      if (pending) {
        res.status(409).json({ error: 'A proposed change is awaiting your confirmation. Confirm or decline it first.' });
        return;
      }
    } else {
      conversationId = await createConversation({
        workspaceId,
        createdBy: userId,
        entityId: focal.id,
        entityType: entityType as FleetEntityType,
      });
    }

    // ── Rate limit ONCE, before graph entry (resume never re-bills, per U7) ──
    if (!checkFleetChatRateLimit(userId)) {
      res.status(429).json({ error: 'Too many Fleet chat turns. Please try again later.' });
      return;
    }

    // Persist the user's turn before streaming the answer.
    await appendTurn(conversationId, { role: 'user', content: message });

    // ── SSE headers BEFORE first write — disables compression buffering ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    res.flushHeaders?.();

    // ── Abort on client disconnect ──
    // We thread an AbortController into the graph run via `config.signal`. A
    // genuine client disconnect (before the run reaches its terminal event)
    // aborts the in-flight graph. We do NOT abort once the stream has produced its
    // terminal event (`streamDone`) — by then the graph is done and a late
    // end-of-response `close` must not abort mid-persist. After a disconnect we
    // keep CONSUMING the generator (just stop writing to the dead socket) so the
    // graph finishes cleanly and a paused write is never half-persisted.
    const abort = new AbortController();
    let streamDone = false;
    let disconnected = false;
    req.on('close', () => {
      if (!streamDone) {
        disconnected = true;
        abort.abort();
      }
    });

    let answerText = '';
    let finalEvent: ChatStreamEvent | null = null;
    try {
      for await (const event of streamChatTurn(
        { conversationDocId: conversationId, entityId: focal.id, entityType: entityType as FleetEntityType, message, ctx, signal: abort.signal },
        getCompiledGraph()
      )) {
        if (event.type === 'token') answerText += event.token;
        if (event.type === 'final' || event.type === 'paused') {
          finalEvent = event;
          streamDone = true; // terminal reached; ignore any later `close`.
        }
        if (!disconnected) res.write(sseFrame(event));
      }
      streamDone = true;
    } catch (err) {
      if (!disconnected) {
        console.error('FleetGraph chat stream error:', err);
        res.write(sseFrame({ type: 'final', answer: '', threadId: conversationId } as ChatStreamEvent));
      }
    }

    // ── Record the one-in-flight-turn marker + persist the assistant turn. ──
    // The marker MUST be persisted based on the terminal stream event REGARDLESS
    // of `disconnected` (B6): the graph keeps running after a client disconnect
    // (we kept consuming the generator), so a 'paused' terminal means a real
    // interrupt checkpoint was persisted. If we skipped the marker on disconnect,
    // that checkpoint would be orphaned (no pending marker) and the NEXT turn
    // would clobber it. The DB write does not touch the dead socket, so it is
    // safe to run even when disconnected. Marker and checkpoint cannot diverge.
    if (finalEvent?.type === 'paused') {
      // A proposal awaits confirmation — store the structured proposal so a
      // concurrent turn is rejected (409) AND the GET can re-surface the
      // confirmable card after navigation (U10), until confirm/decline clears it.
      await setPending(conversationId, finalEvent.proposal);
    } else if (finalEvent?.type === 'final') {
      // A resolved turn left no checkpoint (streamChatTurn cleared it). Persist
      // the assistant transcript even on disconnect so reopening shows the answer.
      const persisted = finalEvent.answer || answerText;
      if (persisted) await appendTurn(conversationId, { role: 'assistant', content: persisted });
    }
    res.end();
  } catch (err) {
    console.error('FleetGraph chat error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.end();
  }
});

// ── POST /chat/confirm — resume a paused turn (P0 ownership) ─────────────────

router.post('/chat/confirm', authMiddleware, async (req: Request, res: Response) => {
  if (!assertAuthed(req, res)) return;
  if (!assertProviderAvailable(res)) return;

  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid confirm request', details: parsed.error.flatten() });
    return;
  }
  const { conversationId, approved } = parsed.data;
  const userId = req.userId;
  const workspaceId = req.workspaceId;

  try {
    // P0 (R9): load by thread_id and assert ownership BEFORE resuming. Without
    // this, any authenticated workspace member could resume another user's write.
    const conv = await getConversation(conversationId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (conv.workspaceId !== workspaceId || conv.createdBy !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Atomic double-confirm guard (subsumes the old isPending check + the
    // post-write setPending(null)). `claimPending` removes the marker AND returns
    // the proposal it held in ONE statement, so EXACTLY ONE concurrent confirm
    // wins; every other concurrent confirm claims nothing → 409 with NO resume.
    // This closes the check-then-act race that could resume the same checkpoint
    // twice (duplicate write). We claim UNCONDITIONALLY for both approve and
    // decline: the decline path still needs the marker cleared before resuming
    // with {approved:false}. The marker is now cleared atomically BEFORE resume,
    // so there is no later setPending(null) and thus no failure window that could
    // strand the marker → permanent 409 lockout (the old bug).
    const claimed = await claimPending(conversationId);
    if (!claimed) {
      res.status(409).json({ error: 'No pending proposal to confirm (already resolved).' });
      return;
    }

    // EDGE: if resumeChatTurn throws AFTER the claim, the marker is already gone
    // (no automatic retry) but NO duplicate write occurred — strictly better than
    // a duplicate write. The interrupt checkpoint may be left orphaned; that is a
    // known, accepted residual (resumeChatTurn deleteThreads it on a clean
    // resolve). A 500 here lets the client surface the failure.
    const result = await resumeChatTurn({ conversationDocId: conversationId, approved });

    if (result.status === 'paused') {
      // Should not happen (resume always resolves), but surface it rather than 500.
      res.json({ status: 'paused', proposal: result.proposal, conversationId });
      return;
    }

    // The proposal is resolved (applied or declined) and the write is durably
    // committed. The marker was already cleared atomically by claimPending, so the
    // only remaining cleanup is the best-effort transcript append: a failure here
    // must NOT 500 (the write already succeeded). (resumeChatTurn already cleared
    // the U3 checkpoint.)
    try {
      if (result.answer) await appendTurn(conversationId, { role: 'assistant', content: result.answer });
    } catch (cleanupErr) {
      console.error('FleetGraph confirm cleanup (non-fatal):', cleanupErr);
    }
    res.json({ status: 'answer', answer: result.answer, conversationId, executed: result.executed });
  } catch (err) {
    console.error('FleetGraph confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dedup-review — graph-backed duplicate verdict (stage 2) ────────────
// The issue editor calls this on demand (button click), NOT per keystroke: it
// runs the FleetGraph `dedup` mode (an LLM judgement), which is rate-limited and
// gated on a configured provider. Stage 1 (the cheap per-keystroke typeahead) is
// GET /api/issues/similar — both judge the SAME pg_trgm candidate set.
router.post('/dedup-review', authMiddleware, async (req: Request, res: Response) => {
  if (!assertAuthed(req, res)) return;
  if (!assertProviderAvailable(res)) return;

  const parsed = dedupRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid dedup request', details: parsed.error.flatten() });
    return;
  }
  const { title, excludeId } = parsed.data;
  const userId = req.userId;
  const workspaceId = req.workspaceId;

  try {
    const { isAdmin } = await getVisibilityContext(userId, workspaceId);
    const ctx = { workspaceId, userId, isAdmin };

    // Authorize the draft issue (no leak): a non-visible / nonexistent issue is a
    // 404 — same posture as the chat route. This also bounds the candidate read
    // to a user who can legitimately see the issue they're editing.
    const focal = await fetchFocal(excludeId, 'issue' as FleetEntityType, ctx);
    if (!focal) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }

    // Rate-limit the model call (shared limiter with chat — both spend a turn).
    if (!checkFleetChatRateLimit(userId)) {
      res.status(429).json({ error: 'Too many Fleet requests. Please try again later.' });
      return;
    }

    const review = await runDedupReview({ draftTitle: title, excludeId, ctx });
    res.json(review);
  } catch (err) {
    console.error('FleetGraph dedup-review error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /related-groups — theme-group the workspace's open issues ────────────
// Powers the Issues page "Related" view. Read-only and workspace-wide: the
// server fetches the requesting user's visible open issues itself (no request
// body) and runs the FleetGraph `related` mode to cluster them by theme. Runs
// automatically when the view opens, so results are cached server-side per
// issue-set fingerprint and on the client (react-query); still rate-limited and
// provider-gated. Degrades to a candidates-only payload (the client renders a
// flat list) when the model is unavailable.
router.get('/related-groups', authMiddleware, async (req: Request, res: Response) => {
  if (!assertAuthed(req, res)) return;
  if (!assertProviderAvailable(res)) return;

  const userId = req.userId;
  const workspaceId = req.workspaceId;

  try {
    // Rate-limit the (potential) model call (shared limiter with chat/dedup —
    // each spends a turn). A whole-workspace grouping is one expensive turn.
    if (!checkFleetChatRateLimit(userId)) {
      res.status(429).json({ error: 'Too many Fleet requests. Please try again later.' });
      return;
    }

    const { isAdmin } = await getVisibilityContext(userId, workspaceId);
    const ctx = { workspaceId, userId, isAdmin };

    const result = await runRelatedGroups({ ctx });
    res.json(result);
  } catch (err) {
    console.error('FleetGraph related-groups error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /conversations/:id — owner or workspace admin only (P0) ──────────────

router.get('/conversations/:id', authMiddleware, async (req: Request, res: Response) => {
  if (!assertAuthed(req, res)) return;
  const { id } = req.params;
  const userId = req.userId;
  const workspaceId = req.workspaceId;

  try {
    const conv = await getConversation(id as string);
    if (!conv || conv.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    // P0 (R9): owner OR workspace admin only — transcripts hold fetched
    // issue/standup/people content.
    const owner = conv.createdBy === userId;
    const admin = owner ? false : await isWorkspaceAdmin(userId, workspaceId);
    if (!owner && !admin) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Return the structured pending proposal (or null) so U10 can re-render the
    // confirmable card after navigation, not just a boolean.
    const pendingProposal = await getPendingProposal(id as string);
    res.json({
      id: conv.id,
      entityId: conv.entityId,
      entityType: conv.entityType,
      transcript: conv.transcript,
      pendingProposal,
    });
  } catch (err) {
    console.error('FleetGraph conversation fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
