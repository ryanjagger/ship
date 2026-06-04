import { describe, it, expect } from 'vitest';
import { buildEvents, diffAttributes } from '../events.js';
import {
  allEventTypes,
  getEventDefinition,
  isKnownEventType,
  requiredReadScopes,
  WEBHOOK_API_VERSION,
} from '../registry.js';
import { TYPED_DOCUMENT_RESOURCES } from '../../api/v1/schemas/typed-document.js';

const actor = { workspaceId: 'ws-1', actorUserId: 'user-1' };
const issue = TYPED_DOCUMENT_RESOURCES.find((r) => r.eventResource === 'issue')!;

describe('webhook event registry', () => {
  it('registers lifecycle events for every typed resource', () => {
    for (const resource of TYPED_DOCUMENT_RESOURCES) {
      for (const action of ['created', 'updated', 'deleted']) {
        expect(isKnownEventType(`${resource.eventResource}.${action}`)).toBe(true);
      }
    }
  });

  it('uses wiki_page (not wiki) as the public event family', () => {
    expect(isKnownEventType('wiki_page.created')).toBe(true);
    expect(isKnownEventType('wiki.created')).toBe(false);
  });

  it('never exposes a document.* event type', () => {
    expect(allEventTypes().some((t) => t.startsWith('document.'))).toBe(false);
  });

  it('registers deferred semantic events but marks them not-emitted', () => {
    for (const type of ['project.completed', 'sprint.started', 'sprint.completed']) {
      expect(getEventDefinition(type)?.emitted).toBe(false);
    }
    for (const type of ['issue.assigned', 'issue.status_changed', 'weekly_plan.submitted']) {
      expect(getEventDefinition(type)?.emitted).toBe(true);
    }
  });

  it('requires people:read with no documents:read fallback for person.*', () => {
    expect(requiredReadScopes('person.created')).toEqual(['people:read']);
    expect(requiredReadScopes('issue.created')).toEqual(['issues:read', 'documents:read']);
  });
});

describe('buildEvents', () => {
  it('emits one created event with the object and no previous_attributes', () => {
    const events = buildEvents(issue, actor, { kind: 'created', after: { id: 'i1', state: 'backlog' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'issue.created',
      api_version: WEBHOOK_API_VERSION,
      workspace_id: 'ws-1',
      actor_user_id: 'user-1',
      data: { object: { id: 'i1', state: 'backlog' } },
    });
    expect(events[0]!.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(events[0]!.idempotency_key).toBe(events[0]!.id);
    expect(events[0]!.previous_attributes).toBeUndefined();
  });

  it('emits a tombstone (not the stale object) for deletes', () => {
    const events = buildEvents(issue, actor, { kind: 'deleted', id: 'i9' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'issue.deleted', data: { object: { id: 'i9', object: 'issue', deleted: true } } });
  });

  it('emits base updated + issue.status_changed when state changes', () => {
    const events = buildEvents(issue, actor, {
      kind: 'updated',
      before: { id: 'i1', state: 'backlog', assignee_id: 'a1' },
      after: { id: 'i1', state: 'in_progress', assignee_id: 'a1' },
    });
    const types = events.map((e) => e.type);
    expect(types).toEqual(['issue.updated', 'issue.status_changed']);
    // previous_attributes carries the OLD value of the changed field
    expect(events[0]!.previous_attributes).toEqual({ state: 'backlog' });
    expect(events.every((e) => e.id !== events[0]!.id || e === events[0])).toBe(true);
  });

  it('emits issue.assigned including null↔non-null transitions', () => {
    const events = buildEvents(issue, actor, {
      kind: 'updated',
      before: { id: 'i1', state: 'todo', assignee_id: null },
      after: { id: 'i1', state: 'todo', assignee_id: 'a2' },
    });
    expect(events.map((e) => e.type)).toEqual(['issue.updated', 'issue.assigned']);
  });

  it('emits weekly_plan.submitted only on null→present submitted_at', () => {
    const plan = TYPED_DOCUMENT_RESOURCES.find((r) => r.eventResource === 'weekly_plan')!;
    const submitted = buildEvents(plan, actor, {
      kind: 'updated',
      before: { id: 'p1', submitted_at: null },
      after: { id: 'p1', submitted_at: '2026-06-03T00:00:00Z' },
    });
    expect(submitted.map((e) => e.type)).toEqual(['weekly_plan.updated', 'weekly_plan.submitted']);

    const alreadySubmitted = buildEvents(plan, actor, {
      kind: 'updated',
      before: { id: 'p1', submitted_at: '2026-06-01T00:00:00Z' },
      after: { id: 'p1', submitted_at: '2026-06-03T00:00:00Z' },
    });
    expect(alreadySubmitted.map((e) => e.type)).toEqual(['weekly_plan.updated']);
  });

  it('emits no semantic event for resources without a hook (program)', () => {
    const program = TYPED_DOCUMENT_RESOURCES.find((r) => r.eventResource === 'program')!;
    const events = buildEvents(program, actor, {
      kind: 'updated',
      before: { id: 'pr1', name: 'A' },
      after: { id: 'pr1', name: 'B' },
    });
    expect(events.map((e) => e.type)).toEqual(['program.updated']);
  });
});

describe('diffAttributes', () => {
  it('returns changed fields with their previous values', () => {
    expect(diffAttributes({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 })).toEqual({ b: 2 });
  });

  it('deep-compares arrays/objects', () => {
    expect(diffAttributes({ tags: ['x'] }, { tags: ['x'] })).toEqual({});
    expect(diffAttributes({ tags: ['x'] }, { tags: ['y'] })).toEqual({ tags: ['x'] });
  });
});
