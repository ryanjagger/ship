import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Drift } from '@ship/shared';
import { DriftBadge } from './DriftBadge';

describe('DriftBadge', () => {
  it('renders severity and exposes all reasons via the accessible name', () => {
    const drift: Drift = {
      isDrifting: true,
      signals: [
        { type: 'idle', reason: 'idle 9 days' },
        { type: 'stale_plan', reason: 'plan stale 24 days' },
        { type: 'rising_incomplete_work', reason: 'incomplete work +2 in 7d' },
      ],
    };

    render(<DriftBadge drift={drift} />);

    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Drifting · 3');
    const label = badge.getAttribute('aria-label') ?? '';
    expect(label).toContain('idle 9 days');
    expect(label).toContain('plan stale 24 days');
    expect(label).toContain('incomplete work +2 in 7d');
  });

  it('renders nothing when drift is null (ineligible project)', () => {
    const { container } = render(<DriftBadge drift={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when eligible but not drifting', () => {
    const { container } = render(<DriftBadge drift={{ isDrifting: false, signals: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a non-interactive span (no focus stop, no button role)', () => {
    render(<DriftBadge drift={{ isDrifting: true, signals: [{ type: 'idle', reason: 'idle 8 days' }] }} />);
    const badge = screen.getByRole('status');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).not.toHaveAttribute('tabindex');
  });
});
