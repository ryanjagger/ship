import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { pool } from '../../db/client.js';
import { ConversationDocCheckpointSaver } from './checkpointer.js';

// U3 — checkpointer.test.ts
//
// These tests exercise the custom JSONB checkpointer against a REAL Postgres
// conversation-doc row (the dev DB, ship_dev). The shared test setup
// (src/test/setup.ts) TRUNCATEs all tables before this file runs, so we own a
// clean slate and create our own workspace + conversation fixtures here.

let workspaceId: string;
let threadId: string; // == conversation document id

/** Make a minimally-valid Checkpoint object (the shape LangGraph persists). */
function makeCheckpoint(id: string, value: unknown): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { __test__: value },
    channel_versions: { __test__: 1 },
    versions_seen: {},
  };
}

function makeMetadata(step: number): CheckpointMetadata {
  return { source: 'loop', step, parents: {} };
}

function configFor(tid: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: tid,
      checkpoint_ns: '',
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
  };
}

/** Read the raw fleetgraph_checkpoint blob (and transcript) off the doc row. */
async function readProps(id: string): Promise<Record<string, unknown>> {
  const res = await pool.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM documents WHERE id = $1`,
    [id]
  );
  return res.rows[0]?.properties ?? {};
}

beforeEach(async () => {
  // Create the workspace + a fresh conversation doc per test so latest-only
  // semantics are isolated. (Workspace is recreated each time because the
  // shared setup.ts beforeAll TRUNCATEs workspaces before this file runs.)
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('U3 Checkpointer Test WS') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;

  const doc = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, properties)
     VALUES ($1, 'conversation', 'U3 conversation', '{}'::jsonb)
     RETURNING id`,
    [workspaceId]
  );
  threadId = doc.rows[0]!.id;
});

afterEach(async () => {
  // Workspace cascade removes the conversation docs. (Pool closed by teardown.)
  if (workspaceId) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

describe('ConversationDocCheckpointSaver', () => {
  it('put then getTuple round-trips a checkpoint tuple for a thread_id', async () => {
    const saver = new ConversationDocCheckpointSaver(pool);
    const cp = makeCheckpoint('cp-1', { hello: 'world' });

    const returned = await saver.put(configFor(threadId), cp, makeMetadata(0), {});
    expect(returned.configurable?.checkpoint_id).toBe('cp-1');
    expect(returned.configurable?.thread_id).toBe(threadId);

    const tuple = await saver.getTuple(configFor(threadId));
    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.id).toBe('cp-1');
    expect(tuple!.checkpoint.channel_values.__test__).toEqual({ hello: 'world' });
    expect(tuple!.metadata).toEqual(makeMetadata(0));
  });

  it('a second put for the same thread_id overwrites (latest-only)', async () => {
    const saver = new ConversationDocCheckpointSaver(pool);
    await saver.put(configFor(threadId), makeCheckpoint('cp-1', { n: 1 }), makeMetadata(0), {});
    await saver.put(configFor(threadId), makeCheckpoint('cp-2', { n: 2 }), makeMetadata(1), {});

    const tuple = await saver.getTuple(configFor(threadId));
    expect(tuple!.checkpoint.id).toBe('cp-2');
    expect(tuple!.checkpoint.channel_values.__test__).toEqual({ n: 2 });

    // list yields exactly the single stored (latest) tuple.
    const seen: string[] = [];
    for await (const t of saver.list(configFor(threadId))) seen.push(t.checkpoint.id);
    expect(seen).toEqual(['cp-2']);
  });

  it('putWrites pending writes are retrievable in the next getTuple', async () => {
    const saver = new ConversationDocCheckpointSaver(pool);
    await saver.put(configFor(threadId), makeCheckpoint('cp-1', { n: 1 }), makeMetadata(0), {});

    // Pending writes are keyed to the checkpoint that was just put.
    await saver.putWrites(
      configFor(threadId, 'cp-1'),
      [
        ['channelA', { wrote: 'a' }],
        ['channelB', { wrote: 'b' }],
      ],
      'task-1'
    );

    const tuple = await saver.getTuple(configFor(threadId));
    expect(tuple!.pendingWrites).toBeDefined();
    const writes = tuple!.pendingWrites!;
    expect(writes).toHaveLength(2);
    // [taskId, channel, value]
    expect(writes).toContainEqual(['task-1', 'channelA', { wrote: 'a' }]);
    expect(writes).toContainEqual(['task-1', 'channelB', { wrote: 'b' }]);
  });

  it('survives the cross-request boundary: a fresh saver instance reads stored state (R16)', async () => {
    const writer = new ConversationDocCheckpointSaver(pool);
    await writer.put(configFor(threadId), makeCheckpoint('cp-1', { resumed: true }), makeMetadata(2), {});
    await writer.putWrites(configFor(threadId, 'cp-1'), [['ch', { pending: 1 }]], 'task-x');

    // Brand-new instance, same pool — simulates a separate HTTP request / process
    // with no in-memory graph state.
    const reader = new ConversationDocCheckpointSaver(pool);
    const tuple = await reader.getTuple(configFor(threadId));
    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.id).toBe('cp-1');
    expect(tuple!.checkpoint.channel_values.__test__).toEqual({ resumed: true });
    expect(tuple!.metadata).toEqual(makeMetadata(2));
    expect(tuple!.pendingWrites).toContainEqual(['task-x', 'ch', { pending: 1 }]);
  });

  it('getTuple for an unknown thread_id returns undefined; deleteThread removes the checkpoint', async () => {
    const saver = new ConversationDocCheckpointSaver(pool);

    // Unknown thread (a valid-but-empty conversation doc): no checkpoint yet.
    expect(await saver.getTuple(configFor(threadId))).toBeUndefined();

    await saver.put(configFor(threadId), makeCheckpoint('cp-1', { n: 1 }), makeMetadata(0), {});
    expect(await saver.getTuple(configFor(threadId))).toBeDefined();

    await saver.deleteThread(threadId);
    expect(await saver.getTuple(configFor(threadId))).toBeUndefined();

    // deleteThread cleared only the checkpoint key, leaving the row intact.
    const props = await readProps(threadId);
    expect(props.fleetgraph_checkpoint).toBeUndefined();
  });

  it('checkpoint put and a concurrent transcript-style write to the same row both survive', async () => {
    const saver = new ConversationDocCheckpointSaver(pool);

    // Simulate U9's transcript appender: a separate single-statement jsonb_set on
    // its own disjoint top-level key (properties.fleetgraph_transcript).
    const writeTranscript = (entry: unknown) =>
      pool.query(
        `UPDATE documents
            SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{fleetgraph_transcript}', $1::jsonb, true)
          WHERE id = $2`,
        [JSON.stringify([entry]), threadId]
      );

    // Fire both writes "concurrently" — neither does a read-modify-write of the
    // whole properties blob, so disjoint keys must not clobber each other.
    await Promise.all([
      saver.put(configFor(threadId), makeCheckpoint('cp-1', { paused: true }), makeMetadata(0), {}),
      writeTranscript({ role: 'user', text: 'hi' }),
    ]);

    const props = await readProps(threadId);
    expect(props.fleetgraph_checkpoint).toBeDefined();
    expect(props.fleetgraph_transcript).toEqual([{ role: 'user', text: 'hi' }]);

    // And the checkpoint is still resumable.
    const tuple = await saver.getTuple(configFor(threadId));
    expect(tuple!.checkpoint.id).toBe('cp-1');

    // A subsequent checkpoint put must not wipe the transcript.
    await saver.put(configFor(threadId), makeCheckpoint('cp-2', { paused: false }), makeMetadata(1), {});
    const props2 = await readProps(threadId);
    expect(props2.fleetgraph_transcript).toEqual([{ role: 'user', text: 'hi' }]);
    expect((await saver.getTuple(configFor(threadId)))!.checkpoint.id).toBe('cp-2');
  });
});
