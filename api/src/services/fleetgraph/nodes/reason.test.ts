import { describe, it, expect } from 'vitest';
import { buildChatSystemPrompt } from './reason.js';
import type { FetchNodeOutput } from './fetch.js';

// Minimal valid FetchNodeOutput fixture; only the fields the prompt reads matter.
function fetched(overrides: Partial<FetchNodeOutput> = {}): FetchNodeOutput {
  return {
    fetchDenied: false,
    focal: {
      id: 'proj-1',
      entityType: 'project',
      documentType: 'project',
      title: 'P1',
      body: '',
      properties: { plan: null, status: null, targetDate: null, planValidated: null, state: null, priority: null, assigneeId: null, successCriteria: [], monetaryImpactExpected: null, monetaryImpactActual: null },
    },
    associations: { ancestors: [], issues: [], weeks: [] },
    people: [
      { id: 'person-dev', userId: 'user-dev', name: 'Dev User', role: 'admin' },
      { id: 'person-alice', userId: 'user-alice', name: 'Alice Chen', role: 'member' },
    ],
    recentActivity: [],
    ...overrides,
  };
}

describe('buildChatSystemPrompt — current-user identity (assign-to-me)', () => {
  it('names the current user resolved from ctx.userId against the roster', () => {
    const prompt = buildChatSystemPrompt(fetched(), 'user-dev');
    expect(prompt).toContain('current_user: Dev User(user-dev)');
  });

  it('instructs the model to resolve self-references instead of asking who they are', () => {
    const prompt = buildChatSystemPrompt(fetched(), 'user-dev');
    expect(prompt).toMatch(/resolve it to current_user/i);
    expect(prompt).toMatch(/do NOT ask who they are/i);
  });

  it('surfaces the bare id when the speaker is not in the project roster', () => {
    const prompt = buildChatSystemPrompt(fetched(), 'user-ghost');
    expect(prompt).toContain('current_user: (user-ghost; not in the project roster)');
  });

  it('falls back to (unknown) when no userId is supplied', () => {
    const prompt = buildChatSystemPrompt(fetched(), null);
    expect(prompt).toContain('current_user: (unknown)');
  });

  it('still lists the full people roster alongside current_user', () => {
    const prompt = buildChatSystemPrompt(fetched(), 'user-dev');
    expect(prompt).toContain('people: Dev User(user-dev); Alice Chen(user-alice)');
  });

  it('returns the not-visible prompt (no context block) when there is no focal entity', () => {
    const prompt = buildChatSystemPrompt(fetched({ focal: null }), 'user-dev');
    expect(prompt).toContain('cannot see it');
    expect(prompt).not.toContain('current_user:');
  });
});
