import { describe, it, expect } from 'vitest';
import {
  deterministicPieces,
  statusFromPieces,
  hasQuantity,
  hasText,
  type FleetCheckInput,
} from './fleet-checks.js';

function pieces(input: Partial<FleetCheckInput> = {}) {
  return deterministicPieces({ plan: null, targetDate: null, ...input });
}
function piece(input: Partial<FleetCheckInput>, id: string) {
  const p = pieces(input).find((x) => x.id === id);
  if (!p) throw new Error(`piece ${id} missing`);
  return p;
}

describe('hasQuantity', () => {
  it('matches numbers, percentages, and currency', () => {
    expect(hasQuantity('reduce by 20%')).toBe(true);
    expect(hasQuantity('save $50,000')).toBe(true);
    expect(hasQuantity('cut from 6 to 3 minutes')).toBe(true);
  });
  it('does not match numbers glued to letters', () => {
    expect(hasQuantity('ship the v2 onboarding flow for the h1 cohort')).toBe(false);
  });
  it('is false with no quantity', () => {
    expect(hasQuantity('make onboarding better')).toBe(false);
  });
});

describe('deterministicPieces', () => {
  it('by_how_much reflects a quantity in the plan', () => {
    expect(piece({ plan: 'reduce churn by 20%' }, 'by_how_much').met).toBe(true);
    expect(piece({ plan: 'make onboarding better' }, 'by_how_much').met).toBe(false);
  });

  it('by_when reflects whether a target date is set', () => {
    expect(piece({ plan: 'x', targetDate: '2026-09-30T00:00:00.000Z' }, 'by_when').met).toBe(true);
    expect(piece({ plan: 'x', targetDate: null }, 'by_when').met).toBe(false);
  });

  it('every piece carries a hint for when it is missing', () => {
    for (const p of pieces({ plan: 'x' })) expect(p.hint.length).toBeGreaterThan(0);
  });
});

describe('statusFromPieces', () => {
  it('no plan → no_plan regardless of pieces', () => {
    expect(statusFromPieces(pieces({ plan: '' }), false)).toBe('no_plan');
  });

  it('all evaluated pieces met → looks_testable', () => {
    const p = pieces({ plan: 'reduce churn by 20%', targetDate: '2026-09-30T00:00:00.000Z' });
    expect(p.every((x) => x.met)).toBe(true);
    expect(statusFromPieces(p, true)).toBe('looks_testable');
  });

  it('a missing piece → needs_work', () => {
    // quantity present, no target date
    const p = pieces({ plan: 'reduce churn by 20%', targetDate: null });
    expect(statusFromPieces(p, true)).toBe('needs_work');
  });
});

describe('hasText', () => {
  it('treats whitespace-only as empty', () => {
    expect(hasText('   \n ')).toBe(false);
    expect(hasText('x')).toBe(true);
    expect(hasText(null)).toBe(false);
  });
});
