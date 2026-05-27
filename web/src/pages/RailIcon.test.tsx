import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RailIcon } from './App';
import { TooltipProvider } from '@/components/ui/Tooltip';

function renderRailIcon(props: Partial<React.ComponentProps<typeof RailIcon>> = {}) {
  const onClick = props.onClick ?? vi.fn();
  render(
    <TooltipProvider>
      <RailIcon
        icon={<svg data-testid="icon" />}
        label="Ask Fleet"
        active={false}
        onClick={onClick}
        {...props}
      />
    </TooltipProvider>
  );
  return { onClick };
}

describe('RailIcon disabled state', () => {
  it('does not invoke onClick when disabled and exposes aria-disabled (not native disabled)', () => {
    const { onClick } = renderRailIcon({ disabled: true, disabledLabel: 'Open a project or week to ask Fleet' });
    const button = screen.getByRole('button', { name: /open a project or week/i });

    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled(); // native `disabled` would kill the tooltip
  });

  it('stays keyboard-focusable when disabled so the explanation is reachable', () => {
    renderRailIcon({ disabled: true, disabledLabel: 'Fleet is not configured' });
    const button = screen.getByRole('button', { name: /fleet is not configured/i });

    button.focus();

    expect(button).toHaveFocus();
  });

  it('uses disabledLabel as the accessible name and dims (no active styling)', () => {
    renderRailIcon({ disabled: true, active: true, disabledLabel: 'Open a project or week to ask Fleet' });
    const button = screen.getByRole('button', { name: /open a project or week/i });

    // Disabled dominates over active.
    expect(button).toHaveClass('opacity-40');
    expect(button).not.toHaveClass('bg-border');
  });

  it('falls back to the base label when disabled with no disabledLabel', () => {
    renderRailIcon({ disabled: true });
    expect(screen.getByRole('button', { name: 'Ask Fleet' })).toBeInTheDocument();
  });
});

describe('RailIcon enabled state (regression)', () => {
  it('fires onClick and applies active styling when not disabled', () => {
    const { onClick } = renderRailIcon({ active: true });
    const button = screen.getByRole('button', { name: 'Ask Fleet' });

    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveClass('bg-border');
    expect(button).not.toHaveAttribute('aria-disabled');
  });
});
