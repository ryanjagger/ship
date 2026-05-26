/**
 * U9 — Conversation backing-store documents.
 *
 * A FleetGraph chat conversation is persisted as a HIDDEN `documents` row
 * (`document_type='conversation'`, created by migration 045). It is the join key
 * for the U3 checkpointer (its id IS the graph `thread_id`) and holds the chat
 * transcript. It is associated to the entity it discusses via the `'discusses'`
 * relationship type (migration 045). U2 already excludes `conversation` from the
 * generic list / by-id / search surfaces.
 *
 * ── WHY THE ROW MUST EXIST BEFORE THE FIRST TURN (U7 precondition) ──────────
 * The checkpointer persists by UPDATEing this row by id; if the row is absent the
 * UPDATE matches zero rows and the checkpoint is SILENTLY DROPPED — orphaning a
 * paused write. So `ensureConversation` runs BEFORE graph entry (outside the
 * graph), and a `Command` resume never re-creates it.
 *
 * ── TRANSCRIPT WRITE DISCIPLINE — single-statement, disjoint-key jsonb_set ──
 * `appendTurn` writes ONLY `properties.fleetgraph_transcript` via a
 * single-statement `jsonb_set`. It NEVER reads-modifies-writes the whole
 * `properties` blob. This is DISJOINT from the checkpointer's
 * `properties.fleetgraph_checkpoint` key (U3), so a transcript append and a
 * checkpoint `put` interleaving on the same row cannot clobber each other (a lost
 * checkpoint orphans the paused write; a lost transcript corrupts history).
 * Append uses `COALESCE(... , '[]') || $turn` so it is a true server-side append,
 * not a read-then-write. Does NOT bump `updated_at` (engine state, not a user
 * edit), mirroring the checkpointer + fleet-service cache discipline.
 *
 * Title is `"Untitled"` (Ship convention for all new docs).
 */

import { pool } from '../../db/client.js';
import { resolveDocumentType, type FleetEntityType } from './tools/read.js';
import type { WriteProposal } from './tools/write.js';

/** Top-level disjoint key for the transcript (NEVER overlaps the checkpoint key). */
const TRANSCRIPT_KEY = 'fleetgraph_transcript';
/**
 * Disjoint key recording the write proposal awaiting confirmation (the full
 * `WriteProposal` object, or absent when none). This is the AUTHORITATIVE
 * one-in-flight-turn signal AND the source for re-surfacing the structured
 * proposal card after the user navigates away and reopens the drawer (U10) — set
 * with the proposal when a turn pauses, cleared on confirm/decline. We do NOT
 * reconstruct it from the LangGraph checkpoint's pending writes: on a reused
 * (process-wide singleton) compiled graph, the persisted `__interrupt__`
 * pending-write can be clobbered by a later checkpoint `put`, so
 * `getState().tasks[].interrupts` is unreliable across turns. A route-owned
 * marker on its own disjoint key is deterministic and survives restart (it lives
 * in the conversation row).
 */
const PENDING_KEY = 'fleetgraph_pending';

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ConversationRow {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  entityId: string | null;
  entityType: FleetEntityType | null;
  transcript: TranscriptTurn[];
}

interface RawConversationRow {
  id: string;
  workspace_id: string;
  created_by: string | null;
  properties: Record<string, unknown> | null;
}

/**
 * Create the hidden conversation document and associate it to its entity via the
 * `'discusses'` relationship. Returns the new conversation id (== thread_id).
 *
 * The entityType is stored in `properties.fleetgraph_entity_type` so a later GET
 * / resume can reconstruct the focal entity without re-deriving it. The
 * `discusses` association points to the RESOLVED entity doc (a Week resolves to
 * its `sprint` doc — there is no `week` document type).
 */
export async function createConversation(args: {
  workspaceId: string;
  createdBy: string;
  entityId: string;
  entityType: FleetEntityType;
}): Promise<string> {
  const props = {
    fleetgraph_entity_id: args.entityId,
    fleetgraph_entity_type: args.entityType,
    [TRANSCRIPT_KEY]: [] as TranscriptTurn[],
  };
  // visibility 'private' — a transcript is the creator's; admins still see it via
  // the visibility filter (the GET ownership check enforces owner-or-admin).
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
     VALUES ($1, 'conversation', 'Untitled', $2, 'private', $3::jsonb)
     RETURNING id`,
    [args.workspaceId, args.createdBy, JSON.stringify(props)]
  );
  const conversationId = inserted.rows[0]!.id;

  // Associate conversation → entity (resolved doc) via 'discusses'. The focal
  // entity was already authorized by the caller before this runs.
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, 'discusses')
     ON CONFLICT DO NOTHING`,
    [conversationId, args.entityId]
  );

  return conversationId;
}

/**
 * Load a conversation row by id (thread_id). Returns null when no row exists.
 * Reads only the columns the route needs for the ownership check + transcript
 * render. Does NOT apply the generic doc visibility filter — the caller (route)
 * applies the explicit owner-or-admin ownership check.
 */
export async function getConversation(id: string): Promise<ConversationRow | null> {
  const res = await pool.query<RawConversationRow>(
    `SELECT id, workspace_id, created_by, properties
       FROM documents
      WHERE id = $1 AND document_type = 'conversation'
        AND archived_at IS NULL AND deleted_at IS NULL`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;

  const props = row.properties ?? {};
  const transcript = Array.isArray(props[TRANSCRIPT_KEY])
    ? (props[TRANSCRIPT_KEY] as TranscriptTurn[])
    : [];
  const entityType = (props.fleetgraph_entity_type as FleetEntityType | undefined) ?? null;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    entityId: (props.fleetgraph_entity_id as string | undefined) ?? null,
    entityType,
    transcript,
  };
}

/**
 * Append ONE turn to the transcript via a single-statement, disjoint-key
 * `jsonb_set`. Server-side array append (`|| $turn`) — never read-modify-write of
 * the whole `properties` blob — so a concurrent checkpoint `put` on
 * `fleetgraph_checkpoint` survives. Does NOT bump `updated_at`.
 */
export async function appendTurn(
  conversationId: string,
  turn: Omit<TranscriptTurn, 'at'> & { at?: string }
): Promise<void> {
  const entry: TranscriptTurn = {
    role: turn.role,
    content: turn.content,
    at: turn.at ?? new Date().toISOString(),
  };
  await pool.query(
    `UPDATE documents
        SET properties = jsonb_set(
              COALESCE(properties, '{}'::jsonb),
              '{${TRANSCRIPT_KEY}}',
              COALESCE(properties -> '${TRANSCRIPT_KEY}', '[]'::jsonb) || $1::jsonb,
              true
            )
      WHERE id = $2 AND document_type = 'conversation'`,
    [JSON.stringify([entry]), conversationId]
  );
}

/**
 * Store (or clear) the pending write proposal via a single-statement,
 * disjoint-key write (its own `fleetgraph_pending` key — never read-modify-write
 * of the whole properties blob, so a concurrent checkpoint/transcript write
 * survives). Pass the `WriteProposal` when a turn pauses; pass `null` on
 * confirm/decline to clear it. Does NOT bump `updated_at`.
 */
export async function setPending(
  conversationId: string,
  proposal: WriteProposal | null
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{${PENDING_KEY}}', $1::jsonb, true)
      WHERE id = $2 AND document_type = 'conversation'`,
    [JSON.stringify(proposal), conversationId]
  );
}

/**
 * The structured write proposal awaiting confirmation, or null when none. Used by
 * the conversation GET to re-surface the confirmable card after navigation, and
 * (via {@link isPending}) as the one-in-flight-turn guard.
 */
export async function getPendingProposal(conversationId: string): Promise<WriteProposal | null> {
  const res = await pool.query<{ p: WriteProposal | null }>(
    `SELECT properties -> '${PENDING_KEY}' AS p
       FROM documents WHERE id = $1 AND document_type = 'conversation'`,
    [conversationId]
  );
  const p = res.rows[0]?.p;
  // A cleared marker is stored as JSON null; treat that (and absence) as no-pending.
  return p && typeof p === 'object' ? p : null;
}

/** True when a write proposal is awaiting confirmation on this conversation. */
export async function isPending(conversationId: string): Promise<boolean> {
  return (await getPendingProposal(conversationId)) !== null;
}

/** Map an entityType to its backing document_type (re-export for the route). */
export { resolveDocumentType };
