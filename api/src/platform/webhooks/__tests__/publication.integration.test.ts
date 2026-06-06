import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';

// The signing-secret key must exist before subscriptions.ts encrypts. Lazy key
// resolution means setting it here (before the first encrypt) is sufficient.
process.env.WEBHOOK_SECRET_ENC_KEY ||= crypto.randomBytes(32).toString('hex');

import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createOAuthApp } from '../../oauth/apps.js';
import { issueAccessToken } from '../../oauth/tokens.js';
import { createSubscription } from '../subscriptions.js';
import { createIssueCore, patchIssueCore } from '../../../services/issues-service.js';
import {
  createTypedDocumentCore,
  patchTypedDocumentCore,
} from '../../../services/typed-documents-service.js';
import { TYPED_DOCUMENT_RESOURCES } from '../../api/v1/schemas/typed-document.js';

describe('Webhook publication at the write boundary', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let token: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Webhook Pub WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Webhook Pub Tester') RETURNING id`,
      [`webhook-pub-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const scopes = ['issues:write', 'issues:read', 'webhooks:manage'];
    const created = await createOAuthApp({
      name: 'Webhook Pub App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: scopes,
    });
    appId = created.app.id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes })).accessToken;

    await createSubscription({
      appId,
      workspaceId,
      createdBy: userId,
      url: 'https://example.com/hook',
      events: ['issue.created', 'issue.updated', 'issue.status_changed', 'issue.assigned', 'issue.deleted'],
    });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM webhook_subscriptions WHERE app_id = $1', [appId]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  async function eventsFor(workspaceId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const r = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM webhook_events WHERE workspace_id = $1 ORDER BY created_at, type`,
      [workspaceId]
    );
    return r.rows;
  }

  it('create → update → delete produces the expected events, deliveries, and tombstone', async () => {
    // CREATE
    const created = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Hooked Issue', state: 'backlog' });
    expect(created.status).toBe(201);
    const issueId = created.body.id as string;

    let events = await eventsFor(workspaceId);
    expect(events.map((e) => e.type)).toContain('issue.created');
    const createdEvent = events.find((e) => e.type === 'issue.created')!;
    expect((createdEvent.payload.data as { object: { id: string } }).object.id).toBe(issueId);

    // A delivery row was fanned out for the matching subscription.
    const deliveries = await pool.query(
      `SELECT d.status FROM webhook_deliveries d
       JOIN webhook_events e ON e.id = d.event_id
       WHERE e.type = 'issue.created' AND e.workspace_id = $1`,
      [workspaceId]
    );
    expect(deliveries.rowCount).toBe(1);
    expect(deliveries.rows[0]).toMatchObject({ status: 'pending' });

    // UPDATE that changes state and assignee → base + two semantic events.
    const patched = await request(app)
      .patch(`/api/v1/issues/${issueId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'in_progress', assignee_id: userId });
    expect(patched.status).toBe(200);

    events = await eventsFor(workspaceId);
    const types = events.map((e) => e.type);
    expect(types).toContain('issue.updated');
    expect(types).toContain('issue.status_changed');
    expect(types).toContain('issue.assigned');
    const updated = events.find((e) => e.type === 'issue.updated')!;
    expect(updated.payload.previous_attributes).toMatchObject({ state: 'backlog' });

    // DELETE → tombstone, not the stale object.
    const deleted = await request(app).delete(`/api/v1/issues/${issueId}`).set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(204);

    events = await eventsFor(workspaceId);
    const tombstone = events.find((e) => e.type === 'issue.deleted')!;
    expect(tombstone.payload.data).toEqual({ object: { id: issueId, object: 'issue', deleted: true } });
  });

  it('publishes issue webhooks from the Ship UI issue service path', async () => {
    const client = await pool.connect();
    try {
      const ctx = { workspaceId, userId, isAdmin: true };
      const created = await createIssueCore(client, ctx, { title: 'UI Hooked Issue' });
      expect(created.status).toBe(201);
      const issueId = created.body.id as string;

      let events = await eventsFor(workspaceId);
      const createdEvent = events.find(
        (event) =>
          event.type === 'issue.created' &&
          (event.payload.data as { object: { id: string } }).object.id === issueId
      );
      expect(createdEvent).toBeTruthy();

      const createdDelivery = await pool.query(
        `SELECT d.status FROM webhook_deliveries d
         JOIN webhook_events e ON e.id = d.event_id
         WHERE e.type = 'issue.created' AND e.workspace_id = $1 AND e.payload->'data'->'object'->>'id' = $2`,
        [workspaceId, issueId]
      );
      expect(createdDelivery.rowCount).toBe(1);

      const patched = await patchIssueCore(client, ctx, issueId, { assignee_id: userId });
      expect(patched.status).toBe(200);

      events = await eventsFor(workspaceId);
      const assignedEvent = events.find(
        (event) =>
          event.type === 'issue.assigned' &&
          (event.payload.data as { object: { id: string } }).object.id === issueId
      );
      expect(assignedEvent).toBeTruthy();

      const assignedDelivery = await pool.query(
        `SELECT d.status FROM webhook_deliveries d
         JOIN webhook_events e ON e.id = d.event_id
         WHERE e.type = 'issue.assigned' AND e.workspace_id = $1 AND e.payload->'data'->'object'->>'id' = $2`,
        [workspaceId, issueId]
      );
      expect(assignedDelivery.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });

  it('publishes issue webhooks from the typed-document service cores', async () => {
    const resource = TYPED_DOCUMENT_RESOURCES.find((r) => r.documentType === 'issue')!;
    const client = await pool.connect();
    try {
      const ctx = { workspaceId, userId };
      const input = resource.toCreate(resource.createSchema.parse({ title: 'Core Hooked Issue' }));
      const created = await createTypedDocumentCore(client, ctx, resource, input);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.status).toBe(201);
      const issueId = (created.body as { id: string }).id;

      let events = await eventsFor(workspaceId);
      const createdEvent = events.find(
        (event) =>
          event.type === 'issue.created' &&
          (event.payload.data as { object: { id: string } }).object.id === issueId
      );
      expect(createdEvent).toBeTruthy();

      const createdDelivery = await pool.query(
        `SELECT d.status FROM webhook_deliveries d
         JOIN webhook_events e ON e.id = d.event_id
         WHERE e.type = 'issue.created' AND e.workspace_id = $1 AND e.payload->'data'->'object'->>'id' = $2`,
        [workspaceId, issueId]
      );
      expect(createdDelivery.rowCount).toBe(1);

      const update = resource.toUpdate(resource.updateSchema.parse({ assignee_id: userId }));
      const patched = await patchTypedDocumentCore(client, ctx, resource, issueId, update);
      expect(patched.ok).toBe(true);
      if (!patched.ok) return;
      expect(patched.status).toBe(200);

      events = await eventsFor(workspaceId);
      const assignedEvent = events.find(
        (event) =>
          event.type === 'issue.assigned' &&
          (event.payload.data as { object: { id: string } }).object.id === issueId
      );
      expect(assignedEvent).toBeTruthy();
    } finally {
      client.release();
    }
  });

  it('never produces a document.* event type', async () => {
    const r = await pool.query<{ type: string }>(`SELECT DISTINCT type FROM webhook_events WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(r.rows.every((row) => !row.type.startsWith('document.'))).toBe(true);
  });
});
