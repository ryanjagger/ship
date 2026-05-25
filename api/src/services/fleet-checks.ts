/**
 * Fleet deterministic checks.
 *
 * Pure, provider-independent checks that ALWAYS run regardless of whether an AI
 * provider is configured. They answer the four free questions from the plan:
 *   - is there a Project Plan at all?
 *   - are there success criteria?
 *   - does the plan use measurable language?
 *   - does the plan name a timeframe?
 *
 * No DB, no network — input is the already-gathered plan text and success
 * criteria. Heuristics are intentionally small and conservative (directional
 * per the plan); the AI rubric in fleet-service does the nuanced scoring.
 */

import type { FleetFinding, FleetStatus } from '@ship/shared';

export interface FleetCheckInput {
  /** properties.plan text (the synced /plan block / wizard string), or null. */
  plan: string | null;
  /** properties.success_criteria, or empty. */
  successCriteria: string[];
}

export interface FleetCheck {
  id: string;
  label: string;
  passed: boolean;
  /** Why the check failed — surfaced as a finding when not passed. */
  message: string;
}

// A standalone quantity: a number, percentage, or currency amount that is NOT
// glued to letters (so "v2" / "h1" do not count as measurable). \b before the
// digit sits at a word boundary, which does not exist between "v" and "2".
const QUANTITY_RE = /(?<![A-Za-z])\$?\d[\d,]*(?:\.\d+)?\s?%?/;
// Quantitative-change verbs. Deliberately excludes vague words like "better"/
// "improve" — those carry no measurable commitment.
const CHANGE_VERB_RE = /\b(increase|increased|decrease|decreased|reduce|reduced|cut|grow|grew|lower|raise|raised|double|doubled|halve|halved|boost|shrink)\b/i;

const QUARTER_RE = /\bQ[1-4]\b/i;
const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const DURATION_RE = /\bwithin\s+\d+\s+(day|week|month|quarter|year)s?\b/i;
const BY_DATE_RE = /\bby\s+(the\s+)?(end\s+of\s+|start\s+of\s+|q[1-4]\b|\d|next\s|this\s|mid\b|early\b|late\b|[A-Z][a-z]+)/i;
const END_OF_RE = /\bend of\b/i;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;

function hasText(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

function hasMeasurableLanguage(plan: string): boolean {
  return QUANTITY_RE.test(plan) || CHANGE_VERB_RE.test(plan);
}

function hasTimeframeLanguage(plan: string): boolean {
  return (
    QUARTER_RE.test(plan) ||
    MONTH_RE.test(plan) ||
    DURATION_RE.test(plan) ||
    BY_DATE_RE.test(plan) ||
    END_OF_RE.test(plan) ||
    ISO_DATE_RE.test(plan) ||
    SLASH_DATE_RE.test(plan)
  );
}

/**
 * Run the four deterministic checks. Returns one FleetCheck per check (passed or
 * not). Measurable/timeframe checks only run when a plan exists — without plan
 * text they are reported as failed for completeness but the status collapses to
 * `no_plan` regardless.
 */
export function runDeterministicChecks(input: FleetCheckInput): FleetCheck[] {
  const planText = hasText(input.plan) ? (input.plan as string) : '';
  const planPresent = planText.length > 0;
  const hasCriteria = Array.isArray(input.successCriteria) && input.successCriteria.some(hasText);

  return [
    {
      id: 'missing_plan',
      label: 'Project Plan',
      passed: planPresent,
      message: 'No Project Plan found. Use /plan to write one as a testable bet.',
    },
    {
      id: 'missing_success_criteria',
      label: 'Success criteria',
      passed: hasCriteria,
      message: 'No success criteria defined — add the conditions that would prove the plan.',
    },
    {
      id: 'missing_measurable_language',
      label: 'Measurable language',
      passed: planPresent && hasMeasurableLanguage(planText),
      message: 'The plan has no measurable language (a number, percentage, or change like "reduce X by 20%").',
    },
    {
      id: 'missing_timeframe',
      label: 'Timeframe',
      passed: planPresent && hasTimeframeLanguage(planText),
      message: 'The plan names no timeframe (e.g. "by end of Q3", a date, or "within 6 weeks").',
    },
  ];
}

/** Map failed checks to findings (one per failed check). */
export function checksToFindings(checks: FleetCheck[]): FleetFinding[] {
  return checks
    .filter((c) => !c.passed)
    .map((c) => ({ id: c.id, label: c.label, message: c.message }));
}

/**
 * Deterministic-only status (no AI provider). Implements the no-provider rows of
 * the plan's status table: no plan text -> no_plan; any failed check -> needs_work;
 * all four checks pass -> looks_testable.
 */
export function deterministicStatus(checks: FleetCheck[]): FleetStatus {
  const planCheck = checks.find((c) => c.id === 'missing_plan');
  if (planCheck && !planCheck.passed) return 'no_plan';
  return checks.every((c) => c.passed) ? 'looks_testable' : 'needs_work';
}
