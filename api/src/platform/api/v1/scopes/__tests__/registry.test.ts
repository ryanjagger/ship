import { describe, it, expect } from 'vitest';
import { scopeRegistry } from '../registry.js';

/**
 * The scope hierarchy (PRD §5.4): `documents:*` is the SUPERSET of the typed
 * `{wiki,issues,sprints}:*` scopes. `satisfies` is the exact predicate
 * `requireScope` runs, so this pins the one-way privilege relationship that the
 * typed endpoints rely on.
 */
describe('ScopeRegistry · satisfies (privilege hierarchy)', () => {
  it('grants a scope it literally holds', () => {
    expect(scopeRegistry.satisfies(['issues:read'], 'issues:read')).toBe(true);
    expect(scopeRegistry.satisfies(['documents:write'], 'documents:write')).toBe(true);
  });

  it('documents:read is the superset of every typed read scope', () => {
    expect(scopeRegistry.satisfies(['documents:read'], 'issues:read')).toBe(true);
    expect(scopeRegistry.satisfies(['documents:read'], 'sprints:read')).toBe(true);
    expect(scopeRegistry.satisfies(['documents:read'], 'wiki:read')).toBe(true);
  });

  it('documents:write is the superset of every typed write scope', () => {
    expect(scopeRegistry.satisfies(['documents:write'], 'issues:write')).toBe(true);
    expect(scopeRegistry.satisfies(['documents:write'], 'sprints:write')).toBe(true);
    expect(scopeRegistry.satisfies(['documents:write'], 'wiki:write')).toBe(true);
  });

  it('the hierarchy is one-way: a typed scope never satisfies the superset', () => {
    expect(scopeRegistry.satisfies(['issues:read'], 'documents:read')).toBe(false);
    expect(scopeRegistry.satisfies(['wiki:write'], 'documents:write')).toBe(false);
  });

  it('read never satisfies write and vice versa (no cross-grant)', () => {
    expect(scopeRegistry.satisfies(['documents:read'], 'issues:write')).toBe(false);
    expect(scopeRegistry.satisfies(['documents:read'], 'documents:write')).toBe(false);
    expect(scopeRegistry.satisfies(['issues:write'], 'issues:read')).toBe(false);
  });

  it('an unrelated typed scope does not satisfy another resource', () => {
    expect(scopeRegistry.satisfies(['issues:read'], 'sprints:read')).toBe(false);
  });

  it('every scope a route can require is registered', () => {
    for (const s of ['documents:read', 'documents:write', 'wiki:read', 'wiki:write', 'issues:read', 'issues:write', 'sprints:read', 'sprints:write']) {
      expect(scopeRegistry.has(s)).toBe(true);
    }
  });
});
