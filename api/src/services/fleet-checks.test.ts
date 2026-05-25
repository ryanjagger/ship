import { describe, it, expect } from 'vitest';
import {
  runDeterministicChecks,
  checksToFindings,
  deterministicStatus,
  type FleetCheck,
} from './fleet-checks.js';

function check(checks: FleetCheck[], id: string): FleetCheck {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing`);
  return c;
}

describe('runDeterministicChecks', () => {
  it('fails the plan check on empty plan text (AE1)', () => {
    const checks = runDeterministicChecks({ plan: '', successCriteria: [] });
    expect(check(checks, 'missing_plan').passed).toBe(false);
    expect(deterministicStatus(checks)).toBe('no_plan');
  });

  it('treats whitespace-only plan as missing', () => {
    const checks = runDeterministicChecks({ plan: '   \n  ', successCriteria: ['x'] });
    expect(check(checks, 'missing_plan').passed).toBe(false);
    expect(deterministicStatus(checks)).toBe('no_plan');
  });

  it('flags missing measurable + timeframe on a vague plan (AE2)', () => {
    const checks = runDeterministicChecks({
      plan: 'make onboarding better',
      successCriteria: ['Users are happier'],
    });
    expect(check(checks, 'missing_measurable_language').passed).toBe(false);
    expect(check(checks, 'missing_timeframe').passed).toBe(false);
    expect(deterministicStatus(checks)).toBe('needs_work');

    const findings = checksToFindings(checks);
    const ids = findings.map((f) => f.id);
    expect(ids).toContain('missing_measurable_language');
    expect(ids).toContain('missing_timeframe');
    // every finding names a label + message
    for (const f of findings) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it('passes measurable + timeframe on a strong, quantified plan', () => {
    const checks = runDeterministicChecks({
      plan: 'Cut new-user activation time from 6 minutes to under 3 minutes by end of Q3',
      successCriteria: ['Median activation < 3 min'],
    });
    expect(check(checks, 'missing_measurable_language').passed).toBe(true);
    expect(check(checks, 'missing_timeframe').passed).toBe(true);
  });

  it('passes measurable via percentage and timeframe via quarter', () => {
    const checks = runDeterministicChecks({
      plan: 'Reduce X by 20% by end of Q3',
      successCriteria: ['conversion +20%'],
    });
    expect(check(checks, 'missing_measurable_language').passed).toBe(true);
    expect(check(checks, 'missing_timeframe').passed).toBe(true);
    expect(deterministicStatus(checks)).toBe('looks_testable');
  });

  it('returns needs_work when plan present but success criteria empty', () => {
    const checks = runDeterministicChecks({
      plan: 'Reduce checkout time by 30% within 4 weeks',
      successCriteria: [],
    });
    expect(check(checks, 'missing_success_criteria').passed).toBe(false);
    expect(deterministicStatus(checks)).toBe('needs_work');
  });

  it('does not treat numbers glued to letters as measurable', () => {
    const checks = runDeterministicChecks({
      plan: 'Ship the v2 onboarding flow for the h1 cohort',
      successCriteria: ['done'],
    });
    expect(check(checks, 'missing_measurable_language').passed).toBe(false);
  });

  it('all four checks passing yields looks_testable', () => {
    const checks = runDeterministicChecks({
      plan: 'Increase signups by 15% within 2 months',
      successCriteria: ['Signups +15%'],
    });
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checksToFindings(checks)).toHaveLength(0);
    expect(deterministicStatus(checks)).toBe('looks_testable');
  });
});
