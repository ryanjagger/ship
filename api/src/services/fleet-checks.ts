/**
 * Fleet deterministic checks — "is this a good hypothesis?"
 *
 * A testable bet names four things: what will change, for whom, by how much, and
 * by when. "By when" is the project's Target Date (a structured field), so Fleet
 * never parses a timeframe out of prose. The remaining pieces are best judged by
 * the AI rubric; without a provider, deterministic mode evaluates only what it can
 * reliably detect from the plan text — a quantity ("by how much") — plus the
 * structured Target Date ("by when"). It does not guess at outcome or audience.
 *
 * Pure: no DB, no network.
 */

import type { FleetHypothesisPiece, FleetStatus } from '@ship/shared';

export interface FleetCheckInput {
  /** properties.plan text (the synced /plan block / wizard string), or null. */
  plan: string | null;
  /** ISO target date (properties.target_date), or null. Satisfies "by when". */
  targetDate: string | null;
}

// A standalone quantity: a number, percentage, or currency amount not glued to
// letters (so "v2" / "h1" do not count). Covers the "by how much" target.
const QUANTITY_RE = /(?<![A-Za-z])\$?\d[\d,]*(?:\.\d+)?\s?%?/;

export function hasText(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

/** Whether the plan has a quantity that could express a target ("by how much"). */
export function hasQuantity(plan: string): boolean {
  return QUANTITY_RE.test(plan);
}

/**
 * The pieces deterministic mode can evaluate without a model: a quantity in the
 * plan ("by how much") and the structured Target Date ("by when"). Outcome
 * ("what will change") and audience ("for whom") are AI-only and omitted here.
 *
 * M-08: currently has no prod caller (R18 makes the review provider-gated), but
 * retained for the deferred no-provider path; its own unit test still covers it.
 */
export function deterministicPieces(input: FleetCheckInput): FleetHypothesisPiece[] {
  const planText = hasText(input.plan) ? (input.plan as string) : '';
  return [
    {
      id: 'by_how_much',
      label: 'By how much',
      met: planText.length > 0 && hasQuantity(planText),
      hint: 'Add a target number (by how much).',
    },
    {
      id: 'by_when',
      label: 'By when',
      met: hasText(input.targetDate),
      hint: 'Set a Target Date (by when).',
    },
  ];
}

/**
 * Status from the evaluated pieces: no plan text -> no_plan; every evaluated
 * piece met -> looks_testable; otherwise needs_work.
 */
export function statusFromPieces(pieces: FleetHypothesisPiece[], hasPlan: boolean): FleetStatus {
  if (!hasPlan) return 'no_plan';
  return pieces.every((p) => p.met) ? 'looks_testable' : 'needs_work';
}
