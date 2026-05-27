import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FleetChatProvider, useFleetChat } from './FleetChatContext';

// Mock the drawer so these tests stay focused on the provider's state machine
// (no QueryClient / fetch / portal needed). The mock surfaces the props it
// receives so we can assert what the provider drives.
vi.mock('@/components/fleetgraph/FleetGraphChat', () => ({
  FleetGraphChat: (props: { open: boolean; entityId: string; entityType: string }) => (
    <div
      data-testid="drawer"
      data-open={String(props.open)}
      data-entity={`${props.entityType}:${props.entityId}`}
    />
  ),
}));

/** Test harness exposing the provider's actions and current state. */
function Harness() {
  const { isOpen, entity, open, close } = useFleetChat();
  return (
    <div>
      <span data-testid="is-open">{String(isOpen)}</span>
      <span data-testid="entity">{entity ? `${entity.entityType}:${entity.entityId}` : 'none'}</span>
      <button onClick={() => open({ entityId: 'A', entityType: 'project' })}>open A</button>
      <button onClick={() => open({ entityId: 'B', entityType: 'week' })}>open B</button>
      <button onClick={close}>close</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <FleetChatProvider>
      <Harness />
    </FleetChatProvider>
  );
}

describe('FleetChatProvider', () => {
  it('open(entity) sets isOpen and renders the drawer scoped to that entity', () => {
    renderHarness();
    expect(screen.getByTestId('is-open')).toHaveTextContent('false');
    expect(screen.queryByTestId('drawer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'open A' }));

    expect(screen.getByTestId('is-open')).toHaveTextContent('true');
    expect(screen.getByTestId('entity')).toHaveTextContent('project:A');
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(drawer).toHaveAttribute('data-entity', 'project:A');
  });

  it('close() clears the entity and unmounts the drawer (no argument-less re-open)', () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'open A' }));
    expect(screen.getByTestId('drawer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(screen.getByTestId('is-open')).toHaveTextContent('false');
    expect(screen.getByTestId('entity')).toHaveTextContent('none');
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('opening a new entity while already open swaps to the latest entity', () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'open A' }));
    fireEvent.click(screen.getByRole('button', { name: 'open B' }));

    expect(screen.getByTestId('entity')).toHaveTextContent('week:B');
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-entity', 'week:B');
  });

  it('useFleetChat throws when used outside a FleetChatProvider', () => {
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/must be used within a FleetChatProvider/);
    spy.mockRestore();
  });
});
