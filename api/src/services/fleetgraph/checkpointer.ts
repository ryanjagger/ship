/**
 * U3 — Custom JSONB checkpointer on the conversation document.
 *
 * A `BaseCheckpointSaver` subclass that persists the paused-graph state needed
 * to resume a confirmed write, with NO new tables. The latest checkpoint tuple
 * per `thread_id` is stored in `properties.fleetgraph_checkpoint` on the
 * conversation `documents` row.
 *
 * thread_id == conversation document id
 * -------------------------------------
 * The graph is invoked with `configurable.thread_id` set to the conversation
 * document's UUID (a row in `documents` with `document_type='conversation'`,
 * created by U2/U9). That id IS the join key here — there is no separate
 * mapping table. If a caller ever passes a thread_id that is not a real
 * documents.id, the UPDATE simply matches zero rows and the checkpoint is
 * silently dropped (no error) — acceptable, since the only legitimate caller is
 * the chat turn runner that always has a real conversation doc.
 *
 * LATEST-TUPLE-ONLY — concurrency precondition
 * --------------------------------------------
 * Resume for this feature only needs the most recent checkpoint (no
 * time-travel / history). So `list` yields the single stored tuple and each
 * `put`/`putWrites` upserts into one JSONB blob, overwriting any prior
 * checkpoint for the thread. This is correct ONLY IF turns on a single
 * thread_id are serialized: a second chat turn fired on the same conversation
 * while a write proposal is still pending would overwrite the paused checkpoint
 * and discard the first proposal's pending writes. **U9 must enforce one
 * in-flight turn per conversation** (reject/queue a second turn while a
 * proposal is pending). This saver relies on that precondition.
 *
 * WRITE DISCIPLINE — single-statement, disjoint top-level key
 * -----------------------------------------------------------
 * Every write here is a SINGLE-STATEMENT `jsonb_set` on its own disjoint
 * top-level key `properties.fleetgraph_checkpoint` — NEVER a read-modify-write
 * of the whole `properties` blob. U9's transcript appender concurrently writes
 * `properties.fleetgraph_transcript` on the SAME row; a read-modify-write would
 * clobber it (a lost checkpoint orphans the paused write; a lost transcript
 * corrupts history). We also do NOT bump `updated_at` (this is engine state,
 * not a user edit), mirroring the `properties.fleet` cache-write discipline in
 * `fleet-service.ts`.
 *
 * SERIALIZATION INTO JSONB
 * ------------------------
 * LangGraph's serializer (`this.serde`, default `JsonPlusSerializer`) dumps via
 * `dumpsTyped(data) -> [type, Uint8Array]` and reverses via
 * `loadsTyped(type, bytes)`. We store each serialized value as
 * `{ t: type, b: base64(bytes) }` so it round-trips through JSONB regardless of
 * the serde `type` ("json" or "bytes"). On read we base64-decode back to a
 * Uint8Array and call `loadsTyped(t, bytes)`.
 */

import type { Pool } from 'pg';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type ChannelVersions,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

/** A serde-dumped value, JSON-storable: `[type, bytes]` collapsed to base64. */
interface SerializedValue {
  t: string;
  b: string;
}

/** One pending intermediate write: [taskId, channel, serialized value]. */
type StoredWrite = [string, string, SerializedValue];

/**
 * The single JSONB blob persisted at `properties.fleetgraph_checkpoint`.
 * Holds exactly the latest checkpoint for the thread plus its pending writes.
 */
interface StoredCheckpoint {
  checkpoint_id: string;
  checkpoint_ns: string;
  /** parent checkpoint id, if this checkpoint was put with one in config. */
  parent_checkpoint_id?: string;
  checkpoint: SerializedValue;
  metadata: SerializedValue;
  /**
   * Pending writes keyed by `taskId,idx` (the same de-dup key MemorySaver uses),
   * but only for `checkpoint_id` above — writes for any older checkpoint are
   * discarded by the next `put` (latest-only).
   */
  writes: Record<string, StoredWrite>;
}

const PROP_KEY = 'fleetgraph_checkpoint';

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Custom checkpointer storing the latest checkpoint tuple per thread on the
 * conversation document.
 *
 * Pool injection: the pg pool is accepted via the constructor (rather than
 * imported) so tests can inject the shared pool directly, and so U7 (graph
 * assembly) controls construction order. This also honors U7's precondition
 * that the pool must be initialized before use — the caller passes an
 * already-live pool. In production U7 will pass the shared `pool` from
 * `../../db/client.js`.
 */
export class ConversationDocCheckpointSaver extends BaseCheckpointSaver {
  private readonly pool: Pool;

  constructor(pool: Pool, serde?: SerializerProtocol) {
    super(serde);
    this.pool = pool;
  }

  /** Dump any value to a JSON-storable `{ t, b }` via the LangGraph serde. */
  private async dump(value: unknown): Promise<SerializedValue> {
    const [t, bytes] = await this.serde.dumpsTyped(value);
    return { t, b: bytesToB64(bytes) };
  }

  /** Reverse {@link dump}. */
  private async load<T = unknown>(value: SerializedValue): Promise<T> {
    return (await this.serde.loadsTyped(value.t, b64ToBytes(value.b))) as T;
  }

  /** Read the single stored blob for a thread, or undefined if none. */
  private async read(threadId: string): Promise<StoredCheckpoint | undefined> {
    const res = await this.pool.query<{ blob: StoredCheckpoint | null }>(
      `SELECT properties -> '${PROP_KEY}' AS blob
         FROM documents
        WHERE id = $1`,
      [threadId]
    );
    const blob = res.rows[0]?.blob;
    return blob ?? undefined;
  }

  /**
   * Single-statement, disjoint-key upsert of the stored blob. NEVER reads then
   * rewrites the whole `properties` object — only the `fleetgraph_checkpoint`
   * key is touched, so a concurrent transcript write on its own key survives.
   * Does NOT bump `updated_at`.
   */
  private async write(threadId: string, blob: StoredCheckpoint): Promise<void> {
    await this.pool.query(
      `UPDATE documents
          SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{${PROP_KEY}}', $1::jsonb, true)
        WHERE id = $2`,
      [JSON.stringify(blob), threadId]
    );
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return undefined;

    const stored = await this.read(threadId);
    if (!stored) return undefined;

    // Latest-only: a checkpoint_id in config that doesn't match the stored one
    // has no history to return.
    const requestedId = getCheckpointId(config);
    if (requestedId && requestedId !== stored.checkpoint_id) return undefined;

    const checkpoint = await this.load<Checkpoint>(stored.checkpoint);
    const metadata = await this.load<CheckpointMetadata>(stored.metadata);

    const pendingWrites = await Promise.all(
      Object.values(stored.writes ?? {}).map(
        async ([taskId, channel, value]) =>
          [taskId, channel, await this.load(value)] as [string, string, unknown]
      )
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: stored.checkpoint_ns,
          checkpoint_id: stored.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };

    if (stored.parent_checkpoint_id !== undefined) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: stored.checkpoint_ns,
          checkpoint_id: stored.parent_checkpoint_id,
        },
      };
    }

    return tuple;
  }

  /**
   * Yields the single stored (latest) tuple. No history/time-travel: `before`,
   * `limit`, and `filter` are honored only insofar as they could exclude the
   * one stored tuple.
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    if (limit !== undefined && limit <= 0) return;

    const tuple = await this.getTuple({
      configurable: { thread_id: config.configurable?.thread_id },
    });
    if (!tuple) return;

    const checkpointId = tuple.config.configurable?.checkpoint_id as string | undefined;
    if (before?.configurable?.checkpoint_id && checkpointId !== undefined) {
      if (checkpointId >= (before.configurable.checkpoint_id as string)) return;
    }
    if (filter && tuple.metadata) {
      const md = tuple.metadata as Record<string, unknown>;
      const matches = Object.entries(filter).every(([k, v]) => md[k] === v);
      if (!matches) return;
    }

    yield tuple;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) {
      throw new Error(
        'ConversationDocCheckpointSaver.put: missing required "thread_id" in config.configurable.'
      );
    }
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const prepared = copyCheckpoint(checkpoint);

    const blob: StoredCheckpoint = {
      checkpoint_id: checkpoint.id,
      checkpoint_ns: checkpointNs,
      parent_checkpoint_id: config.configurable?.checkpoint_id as string | undefined,
      checkpoint: await this.dump(prepared),
      metadata: await this.dump(metadata),
      // New checkpoint => start with an empty pending-writes set. Writes for any
      // prior checkpoint are intentionally discarded (latest-only).
      writes: {},
    };

    await this.write(threadId, blob);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Store intermediate (pending) writes linked to a checkpoint. These are the
   * partial results of an interrupted node, replayed on resume. We attach them
   * to the latest stored checkpoint when the config's checkpoint_id matches it.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!threadId) {
      throw new Error(
        'ConversationDocCheckpointSaver.putWrites: missing required "thread_id" in config.configurable.'
      );
    }
    if (!checkpointId) {
      throw new Error(
        'ConversationDocCheckpointSaver.putWrites: missing required "checkpoint_id" in config.configurable.'
      );
    }

    const stored = await this.read(threadId);
    // If the target checkpoint isn't the one we have stored (latest-only), there
    // is nothing to attach writes to — drop silently, matching the latest-only
    // contract. (In practice putWrites always targets the just-put checkpoint.)
    if (!stored || stored.checkpoint_id !== checkpointId) return;

    const merged: Record<string, StoredWrite> = { ...(stored.writes ?? {}) };
    await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
        const innerKey = `${taskId},${writeIdx}`;
        // Regular writes (idx >= 0) are idempotent per (taskId, idx): once
        // present, don't overwrite. Special writes (negative idx) may update.
        if (writeIdx >= 0 && innerKey in merged) return;
        merged[innerKey] = [taskId, channel, await this.dump(value)];
      })
    );

    stored.writes = merged;
    await this.write(threadId, stored);
  }

  /**
   * Delete the stored checkpoint for a thread. Single-statement, disjoint-key:
   * removes only the `fleetgraph_checkpoint` key, leaving the conversation row
   * and its transcript intact. Does NOT bump `updated_at`.
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.pool.query(
      `UPDATE documents
          SET properties = properties - '${PROP_KEY}'
        WHERE id = $1`,
      [threadId]
    );
  }
}
